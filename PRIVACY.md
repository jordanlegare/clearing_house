# Privacy — Canadian Philanthropy Clearing House

The public discovery layer indexes **public CRA T3010 data** obtained from Open Government Canada. The default ingestion excludes directors/officers because those records are not required for grant discovery.

## Authenticated workflow data

When workflow mode is enabled, the service can process:

- OIDC subject, email/display name supplied by the identity provider;
- organization memberships and organization-claim evidence;
- grant proposals, decisions, terms, consent and compliance records;
- current-status verification evidence;
- notification destinations and delivery state;
- external payment references (not bank credentials);
- reporting preparation and audit records.

Notification destinations are encrypted with AES-256-GCM before database storage. The reference server does not intentionally persist ChatGPT conversation text. Banking credentials are outside the baseline architecture.

A production operator must publish its actual identity, privacy/security contact, hosting locations, subprocessors, retention/deletion practices, rights/access channels, incident response process and other disclosures required by applicable law. If Twilio is enabled, the operator must disclose that SMS/voice destination data is decrypted for transmission to that notification subprocessor.

Private workflow records are organization/role scoped. Public MCP search serialization must never include private organization profiles, OIDC identities, encrypted notification fields, or audit secrets.

Matching is informational. T3010 filing data can be stale or incomplete and must not be represented as a current legal eligibility determination. `record_cra_status_verification` records a current human observation from CRA's List of Charities; it does not represent CRA endorsement of the grant.
