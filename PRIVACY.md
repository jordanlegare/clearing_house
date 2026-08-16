# Privacy — Canadian Philanthropy Clearing House

This reference implementation indexes **public CRA T3010 data** obtained from Open Government Canada. The default ingestion set deliberately excludes the directors/officers resource because it is not needed for foundation-to-charity discovery.

The application does not need donation receipts, banking credentials, donor identities, or recipient bank information to perform discovery and matching. The reference MCP server does not intentionally persist ChatGPT conversation text. A production operator must document its actual hosting provider, logs, retention, authentication, incident response, subprocessors, and contact details before public deployment.

Matching is informational. Do not use this software to infer sensitive traits, automate adverse decisions, determine legal eligibility, or represent that CRA has approved a grant. CRA filing data is self-reported and can be stale or incomplete.
