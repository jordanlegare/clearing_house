# Admin Test Notifications Design

## Purpose

Add a controlled way for a clearing-house system administrator to verify the configured email, SMS, and voice providers without creating a grant, review bundle, recipient contact, or offer batch.

The test must exercise the real encrypted notification outbox, autonomous worker, provider adapter, retry handling, and HMAC audit chain. It must not expose a direct arbitrary-send provider endpoint.

## Scope

The feature adds two authenticated MCP tools:

- `queue_test_notification` queues one controlled delivery test.
- `get_test_notification_status` returns the redacted state of a previously queued test.

The supported channels are `email`, `sms`, and `voice`. The feature does not create grant workflow records, recipient contacts, offer capabilities, organization memberships, or payment records.

## Authorization and Safety Boundary

Only an authenticated actor with the global `system_admin` role may queue or inspect test notifications.

Each queue request requires:

- a supported channel;
- a channel-valid destination;
- a plain-text message of at most 500 characters;
- an optional email subject of at most 120 characters;
- an idempotency key between 8 and 200 characters;
- an exact confirmation string derived from the normalized channel and destination.

The confirmation format is:

```text
SEND TEST <CHANNEL> TO <NORMALIZED_DESTINATION>
```

Every delivered message begins with:

```text
Clearing House delivery test — no grant action is required.
```

The tool accepts plain text only. It does not generate grant links, contact-verification links, HTML, attachments, callbacks, or provider-specific payload fields.

Rate limits are enforced transactionally:

- at most five test notifications per administrator in any rolling hour;
- idempotent replay returns the original test only when channel, normalized destination, subject, and message match;
- semantic mismatch under an existing idempotency key is rejected.

The stored idempotency key is namespaced to the authenticated administrator. A request digest binds the channel, normalized destination, subject, and message without storing the raw destination outside the encrypted recipient column.

## Provider Readiness

The queue operation fails before persistence when the requested channel is unavailable:

- email requires `EMAIL_PROVIDER` to be enabled;
- SMS and voice require `NOTIFICATION_PROVIDER` to be enabled;
- production readiness continues to enforce the credentials required by the selected provider.

The scheduler and worker will treat either an enabled email provider or an enabled phone provider as sufficient to run notification dispatch. This corrects the current email-only scheduling and provider-construction defect.

## Persistence

Migration `016_admin_test_notifications.sql` extends `notification_outbox` with a nullable `created_by` foreign key to `users(id)` and adds an index supporting creator/template/rate-limit queries.

A test notification uses:

- `grant_id = NULL`;
- `template = 'admin_test'`;
- `created_by = <authenticated system administrator>`;
- encrypted `recipient`;
- the fixed-prefix plain-text message in `payload.message`;
- optional email subject in the existing `subject` column;
- an administrator-scoped form of the caller-provided idempotency key;
- a request digest in the payload for semantic replay validation;
- the existing `queued`, `sent`, `failed`, and `cancelled` states.

No raw destination is written to the audit payload, application logs, MCP response, or provider-status response.

## Components

### Repository

Add repository operations to:

- normalize and validate a test request before encryption;
- enforce global-role authorization at the service boundary and transactional rate/idempotency rules in persistence;
- insert an `admin_test` outbox row and append `notification.test_queued` to the audit chain;
- return one test notification only when it was created by the requesting system administrator;
- redact or mask the destination in every returned object.

Existing notification claim, success, failure, and retry operations continue to process the row. Failure recording will populate the existing `last_error` column with a bounded provider error while retaining audit evidence.

### Workflow service

Add `queueTestNotification(actor, args)` and `getTestNotificationStatus(actor, notificationId)` methods. Both require the global `system_admin` role. The queue method also validates provider availability using runtime configuration.

### MCP surface

Register both tools in the authenticated workflow MCP server:

- `queue_test_notification` is consequential and clearly states that it sends an external test message through the autonomous worker.
- `get_test_notification_status` is read-only.

The queue response contains the notification ID, channel, masked destination, status, creation time, and retry limit. The status response additionally contains attempts, sent time, provider message ID, and a bounded redacted failure reason when applicable.

### Worker and scheduler

The notification job is enabled when either phone or email delivery is enabled. Provider construction occurs under the same combined condition. The worker continues to claim outbox rows, decrypt destinations only immediately before provider invocation, and retry failures up to three attempts.

The `admin_test` template uses the stored fixed-prefix message and optional subject without grant or contact-capability handling.

## Data Flow

1. An authenticated system administrator calls `queue_test_notification` with explicit confirmation.
2. The workflow service validates the global role and requested provider availability.
3. The repository normalizes the destination, verifies confirmation, applies rate and idempotency checks, encrypts the destination, inserts the outbox row, and appends an audit entry in one transaction.
4. The autonomous notification worker claims the row under its normal lease and retry behavior.
5. The provider adapter sends through Resend or Twilio.
6. The repository records `sent` with the provider ID, or records a bounded failure and retries up to three attempts.
7. The administrator polls `get_test_notification_status` for the redacted outcome.

## Error Handling

The queue tool rejects:

- unauthenticated or non-system-admin callers;
- unsupported or disabled channels;
- malformed email addresses or non-E.164-compatible phone numbers;
- missing or incorrect confirmation;
- overlong message or subject content;
- rate-limit violations;
- idempotency-key reuse with different request semantics.

Provider failures never reveal credentials or the unmasked destination. The status response may include a bounded provider error sufficient to diagnose authentication, sender-capability, or destination restrictions.

## Testing

Unit coverage will verify:

- MCP schemas and annotations;
- system-admin authorization and rejection of organization-scoped administrators;
- email and phone destination normalization;
- exact confirmation behavior;
- provider availability checks;
- scheduler and worker behavior for email-only, phone-only, both-enabled, and all-disabled configurations;
- fixed-prefix message and subject behavior.

PostgreSQL smoke coverage will verify:

- encrypted destination persistence;
- no-grant outbox insertion;
- HMAC audit entry creation;
- idempotent replay and semantic mismatch rejection;
- five-per-hour rate limiting;
- fake-provider dispatch to `sent`;
- provider failure, bounded error recording, retry, and terminal failure;
- creator-scoped status reads and redaction.

The existing syntax, unit, migrations, schema-readiness, workflow, portal, verified-contact, verified-email, worker, and MCP protocol checks must remain green. After deployment, the live application can queue a controlled email test to `jordanlegare4@gmail.com` and confirm its provider status through the new read tool.

## Out of Scope

- General-purpose transactional messaging.
- Non-admin access to test delivery.
- Bulk test sends or recipient lists.
- Attachments, HTML, custom TwiML, custom provider parameters, or inbound replies.
- Bypassing the worker or retry system.
- Treating successful provider acceptance as proof of recipient inbox placement or human receipt.
