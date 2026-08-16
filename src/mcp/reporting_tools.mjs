import { z } from 'zod';
import {
  getFiscalReportingPackage,
  prepareFiscalReportingPackage,
  previewFiscalReportingPackage,
  setGrantReportingMetadata
} from '../compliance/fiscal_package.mjs';

const readOnly = { readOnlyHint: true, openWorldHint: false, destructiveHint: false };
const consequential = { readOnlyHint: false, openWorldHint: false, destructiveHint: true };
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const uuid = z.string().uuid();

function result(message, data = {}) {
  return { structuredContent: data, content: [{ type: 'text', text: message }] };
}

export function registerFiscalReportingTools(server, { repository, actor }) {
  server.registerTool('set_grant_reporting_metadata', {
    title: 'Set grant CRA reporting metadata',
    description: 'Record reviewable filing metadata that is not inferable from the grant ledger, such as qualified-donee association status, NQD activity location/countries, non-cash value, and designated-gift value. This updates reporting metadata only; it does not mark anything filed.',
    inputSchema: {
      grantId: uuid,
      nonCashCad: z.number().min(0).max(10_000_000_000).default(0),
      activitiesOutsideCanada: z.boolean().nullable().default(null),
      countries: z.array(z.string().regex(/^[A-Z]{2}-.+/)).max(50).default([]),
      associatedCharity: z.boolean().nullable().default(null),
      designatedGiftCad: z.number().min(0).max(10_000_000_000).default(0),
      idempotencyKey: z.string().min(8).max(200)
    },
    annotations: consequential
  }, async args => result('Recorded grant reporting metadata. No CRA filing or grant-state transition occurred.', {
    reportingMetadata: await setGrantReportingMetadata(repository, actor, args)
  }));

  server.registerTool('preview_fiscal_reporting_package', {
    title: 'Preview T3010 T1236 T1441 reporting package',
    description: 'Build a read-only fiscal-period reporting preview from recorded external disbursements, with T3010 lines 5840–5843, 5045 and 5050, T1236 organization rows, T1441 individual grant rows, upload CSV text, exact totals, and filing-readiness flags.',
    inputSchema: {
      foundationOrgId: uuid,
      fiscalPeriodStart: date,
      fiscalPeriodEnd: date
    },
    annotations: readOnly
  }, async args => {
    const packagePreview = await previewFiscalReportingPackage(repository, actor, args);
    return result(packagePreview.filingReady
      ? 'Reporting preview has all grant-ledger metadata required by this package and is ready for filing review.'
      : `Reporting preview needs ${packagePreview.reviewFlags.length} metadata/reconciliation item(s) before filing review.`, { package: packagePreview });
  });

  server.registerTool('prepare_fiscal_reporting_package', {
    title: 'Freeze fiscal reporting package',
    description: 'Persist an immutable hash-bound snapshot of the fiscal-period T3010/T1236/T1441 grant reporting package for filing review and audit reconciliation. This does not submit anything to CRA.',
    inputSchema: {
      foundationOrgId: uuid,
      fiscalPeriodStart: date,
      fiscalPeriodEnd: date,
      idempotencyKey: z.string().min(8).max(200)
    },
    annotations: consequential
  }, async args => result('Prepared an immutable fiscal reporting package. It has not been submitted to CRA.', {
    package: await prepareFiscalReportingPackage(repository, actor, args)
  }));

  server.registerTool('get_fiscal_reporting_package', {
    title: 'Get prepared fiscal reporting package',
    description: 'Retrieve a previously prepared organization-scoped fiscal reporting package, including its immutable package hash and filing-readiness state.',
    inputSchema: { packageId: uuid },
    annotations: readOnly
  }, async ({ packageId }) => result('Loaded the prepared fiscal reporting package.', {
    package: await getFiscalReportingPackage(repository, actor, packageId)
  }));
}
