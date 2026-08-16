# Privacy — Canadian Philanthropy Clearing House

The public discovery layer indexes **public CRA T3010 data** obtained from Open Government Canada. The default ingestion set deliberately excludes the directors/officers resource because it is not needed for foundation-to-charity discovery.

The public search/matching application does not need donation receipts, banking credentials, donor identities, or recipient bank information. The reference MCP server does not intentionally persist ChatGPT conversation text.

## Private workflow data

The production grant workflow introduces private data that the discovery MVP did not require: authenticated user identity, organization claims, recipient contacts, consent records, grant decisions, notification state, compliance decisions and external payment references.

Before `ENABLE_WORKFLOW_WRITES=1` is used in production, the deployed operator must publish an operator-specific privacy notice covering at least:

- operator identity and privacy/security contact;
- purposes for collection/use/disclosure;
- categories of personal information handled;
- hosting providers and subprocessors;
- cross-border processing where applicable;
- retention/deletion schedules;
- access/correction and other applicable privacy-rights channels;
- incident/breach response practices;
- security safeguards appropriate to the sensitivity of the information.

Private workflow data must be access-controlled by organization/role and separated from public MCP search serialization. Access to personal information should be logged. Secrets and encryption/audit keys must not be committed to Git.

Bank-account credentials are deliberately outside the baseline model. The `manual` payment adapter records an external payment reference and cannot execute a bank transfer. Any future direct payment integration requires a separate privacy/security review.

Matching is informational. Do not use this software to infer sensitive traits, automate adverse decisions, determine legal eligibility, or represent that CRA has approved a grant. CRA filing data is self-reported and can be stale or incomplete; a fresh status verification is required before payment authorization in the production workflow.
