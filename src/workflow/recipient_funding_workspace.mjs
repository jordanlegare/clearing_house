import { withTransaction } from '../db/pool.mjs';
import { payloadDigest } from '../security/audit.mjs';
import { PERMISSIONS, requireOrgPermission } from '../security/rbac.mjs';
import {
  assertApplicationSourceVersions,
  buildApplicationPackage,
  flattenApprovedText,
  jsonStringLeavesWithin,
  moneyToCents,
  transitionApplication as applyApplicationTransition
} from '../applications/package.mjs';

const BN_PATTERN = /^\d{9}RR\d{4}$/;

function jsonValue(value, expectedType, fieldName, maxBytes = 50_000) {
  const fallback = expectedType === 'array' ? [] : {};
  const candidate = value ?? fallback;
  if (expectedType === 'array' && !Array.isArray(candidate)) throw new Error(`${fieldName} must be an array.`);
  if (expectedType === 'object' && (!candidate || Array.isArray(candidate) || typeof candidate !== 'object')) {
    throw new Error(`${fieldName} must be an object.`);
  }
  if (!jsonStringLeavesWithin(candidate)) throw new Error(`${fieldName} contains text longer than 10000 characters.`);
  const encoded = JSON.stringify(candidate);
  if (Buffer.byteLength(encoded, 'utf8') > maxBytes) throw new Error(`${fieldName} exceeds ${maxBytes} bytes.`);
  return JSON.parse(encoded);
}

function text(value, fieldName, { min = 0, max = 10_000 } = {}) {
  const normalized = String(value ?? '').trim();
  if (normalized.length < min) throw new Error(`${fieldName} must be at least ${min} characters.`);
  if (normalized.length > max) throw new Error(`${fieldName} exceeds ${max} characters.`);
  return normalized;
}

function timestamp(value) {
  return value?.toISOString?.() || value || null;
}

function profileFromRow(row) {
  if (!row) return null;
  return {
    recipientOrgId: row.recipient_org_id,
    version: row.version,
    mission: row.mission,
    activities: row.activities,
    populations: row.populations,
    geography: row.geography,
    outcomes: row.outcomes,
    governance: row.governance,
    financialSummary: row.financial_summary,
    evidence: row.evidence,
    updatedBy: row.updated_by,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at)
  };
}

function requestFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    recipientOrgId: row.recipient_org_id,
    version: row.version,
    title: row.title,
    purpose: row.purpose,
    amountCad: Number(row.amount_cad),
    objectives: row.objectives,
    activities: row.activities,
    outcomes: row.outcomes,
    budget: row.budget,
    geography: row.geography,
    populations: row.populations,
    evidence: row.evidence,
    status: row.status,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at)
  };
}

function applicationFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    recipientOrgId: row.recipient_org_id,
    fundingRequestId: row.funding_request_id,
    foundationBn: row.foundation_bn,
    foundationName: row.foundation_name,
    foundationSourceYear: row.foundation_source_year,
    status: row.status,
    packageSnapshot: row.package_snapshot,
    packageHash: row.package_hash,
    readiness: row.readiness,
    submissionChannel: row.submission_channel,
    externalSubmissionReference: row.external_submission_reference,
    submittedAt: timestamp(row.submitted_at),
    outcomeRationale: row.outcome_rationale,
    decidedAt: timestamp(row.decided_at),
    readyAt: timestamp(row.ready_at),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at)
  };
}

function normalizeProfile(args) {
  return {
    mission: text(args.mission, 'mission', { max: 10_000 }),
    activities: jsonValue(args.activities, 'array', 'activities'),
    populations: jsonValue(args.populations, 'array', 'populations'),
    geography: jsonValue(args.geography, 'array', 'geography'),
    outcomes: jsonValue(args.outcomes, 'array', 'outcomes'),
    governance: jsonValue(args.governance, 'object', 'governance'),
    financialSummary: jsonValue(args.financialSummary, 'object', 'financialSummary'),
    evidence: jsonValue(args.evidence, 'array', 'evidence')
  };
}

function normalizeRequest(args) {
  const amountCents = moneyToCents(args.amountCad, 'amountCad');
  if (amountCents <= 0) throw new Error('amountCad must be positive.');
  return {
    title: text(args.title, 'title', { min: 2, max: 500 }),
    purpose: text(args.purpose, 'purpose', { min: 3, max: 10_000 }),
    amountCad: amountCents / 100,
    objectives: jsonValue(args.objectives, 'array', 'objectives'),
    activities: jsonValue(args.activities, 'array', 'activities'),
    outcomes: jsonValue(args.outcomes, 'array', 'outcomes'),
    budget: jsonValue(args.budget, 'array', 'budget'),
    geography: jsonValue(args.geography, 'array', 'geography'),
    populations: jsonValue(args.populations, 'array', 'populations'),
    evidence: jsonValue(args.evidence, 'array', 'evidence')
  };
}

function normalizedBn(value) {
  const bn = String(value || '').toUpperCase().replace(/[\s-]/g, '');
  if (!BN_PATTERN.test(bn)) throw new Error('A valid Canadian registered-charity foundation BN is required.');
  return bn;
}

export class RecipientFundingWorkspace {
  constructor({ repository, t3010Repository }) {
    if (!repository?.pool) throw new Error('RecipientFundingWorkspace requires a workflow repository.');
    this.repository = repository;
    this.pool = repository.pool;
    this.t3010Repository = t3010Repository;
  }

  async #idempotent(client, { idempotencyKey, operation, payload }, mutation) {
    const key = text(idempotencyKey, 'idempotencyKey', { min: 8, max: 200 });
    const digest = payloadDigest(payload);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`recipient-funding:${key}`]);
    const existing = (await client.query('SELECT * FROM recipient_funding_operations WHERE idempotency_key=$1', [key])).rows[0];
    if (existing) {
      if (existing.operation !== operation || existing.input_digest !== digest) {
        throw new Error('idempotencyKey was already used with different recipient-funding inputs.');
      }
      return existing.response;
    }
    const result = await mutation(key);
    await client.query(`INSERT INTO recipient_funding_operations
      (idempotency_key,operation,input_digest,resource_id,response)
      VALUES ($1,$2,$3,$4,$5::jsonb)`, [key, operation, digest, result.id || result.recipientOrgId || null, JSON.stringify(result)]);
    return result;
  }

  async getProfile(actor, { recipientOrgId }) {
    requireOrgPermission(actor, recipientOrgId, PERMISSIONS.READ_PRIVATE_ORG);
    const row = (await this.pool.query('SELECT * FROM recipient_funding_profiles WHERE recipient_org_id=$1', [recipientOrgId])).rows[0];
    return profileFromRow(row);
  }

  async upsertProfile(actor, args) {
    requireOrgPermission(actor, args.recipientOrgId, PERMISSIONS.MANAGE_RECIPIENT_FUNDING);
    const normalized = normalizeProfile(args);
    const payload = { recipientOrgId: args.recipientOrgId, expectedVersion: args.expectedVersion ?? null, ...normalized };
    return withTransaction(this.pool, client => this.#idempotent(client, {
      idempotencyKey: args.idempotencyKey,
      operation: 'recipient_funding_profile.upsert',
      payload
    }, async key => {
      const current = (await client.query('SELECT * FROM recipient_funding_profiles WHERE recipient_org_id=$1 FOR UPDATE', [args.recipientOrgId])).rows[0];
      if (current && args.expectedVersion != null && current.version !== args.expectedVersion) {
        throw new Error(`Recipient funding profile version changed from expected ${args.expectedVersion}.`);
      }
      if (!current && args.expectedVersion != null && args.expectedVersion !== 0) {
        throw new Error('New recipient funding profiles require expectedVersion 0 or no expectedVersion.');
      }
      const row = (await client.query(`
        INSERT INTO recipient_funding_profiles
          (recipient_org_id,version,mission,activities,populations,geography,outcomes,governance,financial_summary,evidence,updated_by)
        VALUES ($1,1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10)
        ON CONFLICT (recipient_org_id) DO UPDATE SET
          version=recipient_funding_profiles.version+1,mission=EXCLUDED.mission,activities=EXCLUDED.activities,
          populations=EXCLUDED.populations,geography=EXCLUDED.geography,outcomes=EXCLUDED.outcomes,
          governance=EXCLUDED.governance,financial_summary=EXCLUDED.financial_summary,evidence=EXCLUDED.evidence,
          updated_by=EXCLUDED.updated_by,updated_at=now()
        RETURNING *
      `, [args.recipientOrgId, normalized.mission, JSON.stringify(normalized.activities), JSON.stringify(normalized.populations),
        JSON.stringify(normalized.geography), JSON.stringify(normalized.outcomes), JSON.stringify(normalized.governance),
        JSON.stringify(normalized.financialSummary), JSON.stringify(normalized.evidence), actor.id])).rows[0];
      const result = profileFromRow(row);
      await this.repository.appendAudit(client, {
        actor, organizationId: args.recipientOrgId, action: 'recipient_funding_profile.upsert',
        resourceType: 'recipient_funding_profile', resourceId: args.recipientOrgId, requestId: key,
        payload: { version: result.version, profile: normalized }
      });
      return result;
    }));
  }

  async createRequest(actor, args) {
    requireOrgPermission(actor, args.recipientOrgId, PERMISSIONS.MANAGE_RECIPIENT_FUNDING);
    const normalized = normalizeRequest(args);
    const payload = { recipientOrgId: args.recipientOrgId, ...normalized };
    return withTransaction(this.pool, client => this.#idempotent(client, {
      idempotencyKey: args.idempotencyKey,
      operation: 'recipient_funding_request.create',
      payload
    }, async key => {
      const row = (await client.query(`
        INSERT INTO recipient_funding_requests
          (recipient_org_id,title,purpose,amount_cad,objectives,activities,outcomes,budget,geography,populations,evidence,created_by,updated_by,creation_idempotency_key)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12,$12,$13)
        RETURNING *
      `, [args.recipientOrgId, normalized.title, normalized.purpose, normalized.amountCad,
        JSON.stringify(normalized.objectives), JSON.stringify(normalized.activities), JSON.stringify(normalized.outcomes),
        JSON.stringify(normalized.budget), JSON.stringify(normalized.geography), JSON.stringify(normalized.populations),
        JSON.stringify(normalized.evidence), actor.id, key])).rows[0];
      const result = requestFromRow(row);
      await this.repository.appendAudit(client, {
        actor, organizationId: args.recipientOrgId, action: 'recipient_funding_request.create',
        resourceType: 'recipient_funding_request', resourceId: result.id, requestId: key, payload: normalized
      });
      return result;
    }));
  }

  async updateRequest(actor, args) {
    requireOrgPermission(actor, args.recipientOrgId, PERMISSIONS.MANAGE_RECIPIENT_FUNDING);
    const normalized = normalizeRequest(args);
    const expectedVersion = Number(args.expectedVersion);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new Error('expectedVersion must be a positive integer.');
    const payload = { requestId: args.requestId, recipientOrgId: args.recipientOrgId, expectedVersion, ...normalized };
    return withTransaction(this.pool, client => this.#idempotent(client, {
      idempotencyKey: args.idempotencyKey,
      operation: 'recipient_funding_request.update',
      payload
    }, async key => {
      const current = (await client.query('SELECT * FROM recipient_funding_requests WHERE id=$1 FOR UPDATE', [args.requestId])).rows[0];
      if (!current || current.recipient_org_id !== args.recipientOrgId) throw new Error('Funding request not found for recipient organization.');
      if (current.status !== 'active') throw new Error('Archived funding requests cannot be updated.');
      if (current.version !== expectedVersion) throw new Error(`Funding request version changed from expected ${expectedVersion}.`);
      const row = (await client.query(`UPDATE recipient_funding_requests SET
        version=version+1,title=$2,purpose=$3,amount_cad=$4,objectives=$5::jsonb,activities=$6::jsonb,
        outcomes=$7::jsonb,budget=$8::jsonb,geography=$9::jsonb,populations=$10::jsonb,evidence=$11::jsonb,
        updated_by=$12,updated_at=now() WHERE id=$1 RETURNING *`,
      [args.requestId, normalized.title, normalized.purpose, normalized.amountCad, JSON.stringify(normalized.objectives),
        JSON.stringify(normalized.activities), JSON.stringify(normalized.outcomes), JSON.stringify(normalized.budget),
        JSON.stringify(normalized.geography), JSON.stringify(normalized.populations), JSON.stringify(normalized.evidence), actor.id])).rows[0];
      const result = requestFromRow(row);
      await this.repository.appendAudit(client, {
        actor, organizationId: args.recipientOrgId, action: 'recipient_funding_request.update',
        resourceType: 'recipient_funding_request', resourceId: result.id, requestId: key,
        payload: { expectedVersion, nextVersion: result.version, request: normalized }
      });
      return result;
    }));
  }

  async listRequests(actor, { recipientOrgId, status = 'active', limit = 50 }) {
    requireOrgPermission(actor, recipientOrgId, PERMISSIONS.READ_PRIVATE_ORG);
    if (!['active', 'archived', 'all'].includes(status)) throw new Error('Funding request status filter is invalid.');
    const requestedLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const values = [recipientOrgId, requestedLimit];
    const filter = status === 'all' ? '' : 'AND status=$3';
    if (status !== 'all') values.push(status);
    const rows = (await this.pool.query(`SELECT * FROM recipient_funding_requests
      WHERE recipient_org_id=$1 ${filter} ORDER BY updated_at DESC LIMIT $2`, values)).rows;
    return rows.map(requestFromRow);
  }

  async #requestForActor(actor, recipientOrgId, requestId, permission = PERMISSIONS.READ_PRIVATE_ORG) {
    requireOrgPermission(actor, recipientOrgId, permission);
    const row = (await this.pool.query('SELECT * FROM recipient_funding_requests WHERE id=$1 AND recipient_org_id=$2', [requestId, recipientOrgId])).rows[0];
    if (!row) throw new Error('Funding request not found for recipient organization.');
    return requestFromRow(row);
  }

  #matchFoundationFacts(profile, request, { province = '', limit = 25, minimumSupportSignalCad = 0 } = {}) {
    if (!this.t3010Repository?.matchRecipientFoundations) throw new Error('T3010 foundation data is not available.');
    return this.t3010Repository.matchRecipientFoundations({
      profileText: flattenApprovedText({ mission: profile.mission, activities: profile.activities, populations: profile.populations, geography: profile.geography, outcomes: profile.outcomes }),
      requestText: flattenApprovedText({ title: request.title, purpose: request.purpose, objectives: request.objectives, activities: request.activities, outcomes: request.outcomes }),
      province,
      limit,
      minimumSupportSignalCad
    });
  }

  async matchFoundations(actor, { recipientOrgId, fundingRequestId, province = '', limit = 25, minimumSupportSignalCad = 0 }) {
    requireOrgPermission(actor, recipientOrgId, PERMISSIONS.READ_PRIVATE_ORG);
    const profile = await this.getProfile(actor, { recipientOrgId });
    if (!profile) throw new Error('Create a recipient funding profile before matching foundations.');
    const request = await this.#requestForActor(actor, recipientOrgId, fundingRequestId);
    return this.#matchFoundationFacts(profile, request, { province, limit, minimumSupportSignalCad });
  }

  async prepareApplication(actor, args) {
    requireOrgPermission(actor, args.recipientOrgId, PERMISSIONS.MANAGE_RECIPIENT_FUNDING);
    const foundationBn = normalizedBn(args.foundationBn);
    const province = text(args.province, 'province', { max: 3 }).toUpperCase();
    if (province && !/^[A-Z]{2,3}$/.test(province)) throw new Error('province must be a two- or three-letter code.');
    const payload = {
      recipientOrgId: args.recipientOrgId,
      fundingRequestId: args.fundingRequestId,
      foundationBn,
      province
    };
    return withTransaction(this.pool, client => this.#idempotent(client, {
      idempotencyKey: args.idempotencyKey,
      operation: 'grant_application.prepare',
      payload
    }, async key => {
      const profileRow = (await client.query(`SELECT * FROM recipient_funding_profiles
        WHERE recipient_org_id=$1 FOR SHARE`, [args.recipientOrgId])).rows[0];
      if (!profileRow) throw new Error('Create a recipient funding profile before preparing an application.');
      const requestRow = (await client.query(`SELECT * FROM recipient_funding_requests
        WHERE id=$1 AND recipient_org_id=$2 FOR SHARE`, [args.fundingRequestId, args.recipientOrgId])).rows[0];
      if (!requestRow) throw new Error('Funding request not found for recipient organization.');
      const organization = (await client.query('SELECT * FROM organizations WHERE id=$1', [args.recipientOrgId])).rows[0];
      if (!organization) throw new Error('Recipient organization not found.');
      const profile = profileFromRow(profileRow);
      const request = requestFromRow(requestRow);
      const foundation = this.t3010Repository?.foundationProfile?.(foundationBn);
      if (!foundation) throw new Error('Foundation not found in the loaded T3010 data.');
      const matching = this.#matchFoundationFacts(profile, request, {
        province,
        limit: 100,
        minimumSupportSignalCad: 0
      });
      const selected = matching.matches.find(item => item.bn === foundationBn);
      const built = buildApplicationPackage({
        recipientOrganization: organization,
        profile,
        fundingRequest: request,
        foundation: {
          ...foundation,
          historicalEvidence: foundation.historicalQualifiedDoneeRows
        },
        matchedTerms: selected?.matchedTerms || [],
        matchEvidence: selected?.evidence?.supportingEvidence || []
      });
      const active = (await client.query(`SELECT id FROM grant_applications
        WHERE recipient_org_id=$1 AND funding_request_id=$2 AND foundation_bn=$3 AND status IN ('draft','ready')`,
      [args.recipientOrgId, request.id, foundationBn])).rows[0];
      if (active) throw new Error('An active draft or ready application already exists for this request and foundation.');
      const row = (await client.query(`INSERT INTO grant_applications
        (recipient_org_id,funding_request_id,foundation_bn,foundation_name,foundation_source_year,status,
         package_snapshot,package_hash,readiness,created_by,updated_by,creation_idempotency_key)
        VALUES ($1,$2,$3,$4,$5,'draft',$6::jsonb,$7,$8::jsonb,$9,$9,$10) RETURNING *`,
      [args.recipientOrgId, request.id, foundationBn, foundation.name, foundation.sourceYear || null,
        JSON.stringify(built.packageSnapshot), built.packageHash, JSON.stringify(built.readiness), actor.id, key])).rows[0];
      const result = applicationFromRow(row);
      await this.repository.appendAudit(client, {
        actor, organizationId: args.recipientOrgId, action: 'grant_application.prepare',
        resourceType: 'grant_application', resourceId: result.id, requestId: key,
        payload: { fundingRequestId: request.id, foundationBn, packageHash: built.packageHash, readiness: built.readiness }
      });
      return result;
    }));
  }

  async listApplications(actor, { recipientOrgId, status = 'all', limit = 50 }) {
    requireOrgPermission(actor, recipientOrgId, PERMISSIONS.READ_PRIVATE_ORG);
    const statuses = ['draft', 'ready', 'submitted', 'awarded', 'declined', 'withdrawn'];
    if (status !== 'all' && !statuses.includes(status)) throw new Error('Application status filter is invalid.');
    const values = [recipientOrgId, Math.min(Math.max(Number(limit) || 50, 1), 200)];
    const filter = status === 'all' ? '' : 'AND status=$3';
    if (status !== 'all') values.push(status);
    const rows = (await this.pool.query(`SELECT * FROM grant_applications
      WHERE recipient_org_id=$1 ${filter} ORDER BY updated_at DESC LIMIT $2`, values)).rows;
    return rows.map(applicationFromRow);
  }

  async getApplication(actor, { applicationId }) {
    const row = (await this.pool.query('SELECT * FROM grant_applications WHERE id=$1', [applicationId])).rows[0];
    if (!row) throw new Error('Grant application not found.');
    requireOrgPermission(actor, row.recipient_org_id, PERMISSIONS.READ_PRIVATE_ORG);
    return applicationFromRow(row);
  }

  async transitionApplication(actor, args) {
    const preview = await this.getApplication(actor, { applicationId: args.applicationId });
    requireOrgPermission(actor, preview.recipientOrgId, PERMISSIONS.SUBMIT_RECIPIENT_APPLICATION);
    const transitionInput = {
      packageHash: args.packageHash,
      confirmation: args.confirmation,
      submissionChannel: args.submissionChannel,
      externalSubmissionReference: args.externalSubmissionReference,
      submittedAt: args.submittedAt,
      rationale: args.rationale,
      decidedAt: args.decidedAt,
      idempotencyKey: args.idempotencyKey
    };
    const payload = { applicationId: args.applicationId, nextStatus: args.nextStatus, ...transitionInput };
    return withTransaction(this.pool, client => this.#idempotent(client, {
      idempotencyKey: args.idempotencyKey,
      operation: `grant_application.${args.nextStatus}`,
      payload
    }, async key => {
      const row = (await client.query('SELECT * FROM grant_applications WHERE id=$1 FOR UPDATE', [args.applicationId])).rows[0];
      if (!row) throw new Error('Grant application not found.');
      requireOrgPermission(actor, row.recipient_org_id, PERMISSIONS.SUBMIT_RECIPIENT_APPLICATION);
      const current = applicationFromRow(row);
      if (args.nextStatus === 'ready') {
        const profileVersion = (await client.query(`SELECT version FROM recipient_funding_profiles
          WHERE recipient_org_id=$1 FOR SHARE`, [row.recipient_org_id])).rows[0]?.version;
        const requestSource = (await client.query(`SELECT recipient_org_id,version FROM recipient_funding_requests
          WHERE id=$1 FOR SHARE`, [row.funding_request_id])).rows[0];
        if (profileVersion == null || !requestSource || requestSource.recipient_org_id !== row.recipient_org_id) {
          throw new Error('Application source profile or funding request is no longer available for this recipient.');
        }
        assertApplicationSourceVersions(current, {
          recipientOrgId: row.recipient_org_id,
          fundingRequestId: row.funding_request_id,
          profileVersion,
          requestVersion: requestSource.version
        });
      }
      const next = applyApplicationTransition(current, args.nextStatus, transitionInput);
      const updated = (await client.query(`UPDATE grant_applications SET
        status=$2,ready_at=$3,submission_channel=$4,external_submission_reference=$5,submitted_at=$6,
        outcome_rationale=$7,decided_at=$8,updated_by=$9,updated_at=$10 WHERE id=$1 RETURNING *`,
      [args.applicationId, next.status, next.readyAt || row.ready_at, next.submissionChannel || row.submission_channel,
        next.externalSubmissionReference || row.external_submission_reference, next.submittedAt || row.submitted_at,
        next.outcomeRationale || row.outcome_rationale, next.decidedAt || row.decided_at, actor.id, next.updatedAt])).rows[0];
      await client.query(`INSERT INTO grant_application_events
        (application_id,idempotency_key,from_status,to_status,actor_user_id,metadata,occurred_at)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`, [args.applicationId, key, current.status, next.status, actor.id,
        JSON.stringify(transitionInput), next.updatedAt]);
      const result = applicationFromRow(updated);
      await this.repository.appendAudit(client, {
        actor, organizationId: row.recipient_org_id, action: `grant_application.${next.status}`,
        resourceType: 'grant_application', resourceId: args.applicationId, requestId: key,
        payload: { fromStatus: current.status, toStatus: next.status, transition: transitionInput }
      });
      return result;
    }));
  }
}
