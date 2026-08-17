import crypto from 'node:crypto';
import { withTransaction } from './pool.mjs';
import { buildAuditEntry, payloadDigest } from '../security/audit.mjs';
import { transitionGrant, GRANT_STATES } from '../workflow/grant_lifecycle.mjs';
import { decryptText, encryptText } from '../security/crypto.mjs';
import { maskTestDestination } from '../workflow/test_notifications.mjs';

function normalizeBn(value) {
  return String(value || '').toUpperCase().replace(/[\s-]/g, '');
}

function grantFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    foundationOrgId: row.foundation_org_id,
    recipientOrgId: row.recipient_org_id,
    amountCad: Number(row.amount_cad),
    purpose: row.purpose,
    recipientType: row.recipient_type,
    state: row.state,
    proposedBy: row.proposed_by,
    approvedBy: row.approved_by,
    acceptedBy: row.accepted_by,
    termsVersion: row.terms_version,
    termsDigest: row.terms_digest,
    termsText: row.terms_text,
    offeredAt: row.offered_at?.toISOString?.() || row.offered_at || null,
    createdAt: row.created_at?.toISOString?.() || row.created_at,
    updatedAt: row.updated_at?.toISOString?.() || row.updated_at,
    recipientStatus: row.status_id ? {
      id: row.status_id,
      status: row.status_value,
      assuranceLevel: row.assurance_level,
      source: row.status_source,
      observedStatus: row.observed_status,
      sourceRecordId: row.source_record_id,
      verifiedAt: row.status_verified_at?.toISOString?.() || row.status_verified_at,
      evidence: row.status_evidence || {}
    } : null,
    compliance: row.review_id ? {
      id: row.review_id,
      decision: row.review_decision,
      rationale: row.review_rationale,
      reviewerUserId: row.reviewer_user_id,
      createdAt: row.review_created_at?.toISOString?.() || row.review_created_at
    } : { decision: row.compliance_decision || 'pending' }
  };
}

async function grantDetailed(client, grantId, { forUpdate = false } = {}) {
  const lock = forUpdate ? 'FOR UPDATE OF g' : '';
  const { rows } = await client.query(`
    SELECT g.*,
      s.id AS status_id, s.status AS status_value, s.assurance_level, s.source AS status_source,
      s.observed_status, s.source_record_id, s.verified_at AS status_verified_at, s.evidence AS status_evidence,
      c.id AS review_id, c.decision AS review_decision, c.rationale AS review_rationale,
      c.reviewer_user_id, c.created_at AS review_created_at
    FROM grants g
    LEFT JOIN LATERAL (
      SELECT * FROM recipient_status_checks rs
      WHERE rs.organization_id = g.recipient_org_id AND rs.assurance_level = 'authoritative'
      ORDER BY rs.verified_at DESC LIMIT 1
    ) s ON true
    LEFT JOIN LATERAL (
      SELECT * FROM compliance_reviews cr WHERE cr.grant_id = g.id
      ORDER BY cr.created_at DESC LIMIT 1
    ) c ON true
    WHERE g.id = $1
    ${lock}
  `, [grantId]);
  return grantFromRow(rows[0]);
}

export class WorkflowRepository {
  constructor(pool, { auditHmacKey, encryptionKey }) {
    if (!pool) throw new Error('WorkflowRepository requires a database pool.');
    this.pool = pool;
    this.auditHmacKey = auditHmacKey;
    this.encryptionKey = encryptionKey;
  }

  async #appendAudit(client, { actor, organizationId, action, resourceType, resourceId, requestId, payload }) {
    await client.query('SELECT pg_advisory_xact_lock($1)', [742019301]);
    const previous = await client.query('SELECT entry_hmac FROM audit_log ORDER BY sequence DESC LIMIT 1');
    const occurredAt = new Date().toISOString();
    const entry = buildAuditEntry({
      key: this.auditHmacKey,
      previousDigest: previous.rows[0]?.entry_hmac || '',
      occurredAt,
      actorUserId: actor?.id || '',
      organizationId: organizationId || '',
      action,
      resourceType,
      resourceId: String(resourceId),
      requestId: requestId || '',
      payload
    });
    await client.query(`
      INSERT INTO audit_log
        (occurred_at, actor_user_id, organization_id, action, resource_type, resource_id, request_id, payload_digest, previous_digest, entry_hmac)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `, [occurredAt, actor?.id || null, organizationId || null, action, resourceType, String(resourceId), requestId || null, entry.payloadDigest, entry.previousDigest, entry.entryHmac]);
  }

  async appendAudit(client, args) {
    return this.#appendAudit(client, args);
  }

  async upsertActorFromClaims({ subject, email = null, displayName = null, scopes = [] }) {
    return withTransaction(this.pool, async client => {
      const userResult = await client.query(`
        INSERT INTO users (oidc_subject, email, display_name)
        VALUES ($1,$2,$3)
        ON CONFLICT (oidc_subject) DO UPDATE SET
          email = COALESCE(EXCLUDED.email, users.email),
          display_name = COALESCE(EXCLUDED.display_name, users.display_name)
        RETURNING id, oidc_subject, email, display_name
      `, [subject, email, displayName]);
      const user = userResult.rows[0];
      const global = await client.query('SELECT role FROM user_global_roles WHERE user_id = $1', [user.id]);
      const memberships = await client.query('SELECT organization_id, role FROM memberships WHERE user_id = $1', [user.id]);
      return {
        id: user.id,
        subject: user.oidc_subject,
        email: user.email,
        displayName: user.display_name,
        scopes,
        roles: global.rows.map(row => row.role),
        memberships: memberships.rows.map(row => ({ organizationId: row.organization_id, role: row.role }))
      };
    });
  }

  async findOrganizationByBusinessNumber(businessNumber) {
    const { rows } = await this.pool.query('SELECT * FROM organizations WHERE business_number = $1', [normalizeBn(businessNumber)]);
    return rows[0] || null;
  }

  async getOrganization(organizationId) {
    const { rows } = await this.pool.query('SELECT * FROM organizations WHERE id = $1', [organizationId]);
    return rows[0] || null;
  }

  async upsertPublicOrganization(profile, organizationType = 'registered_charity') {
    const bn = normalizeBn(profile.bn || profile.businessNumber);
    if (!bn) throw new Error('Business number is required.');
    const legalName = profile.name || profile.legalName || bn;
    const { rows } = await this.pool.query(`
      INSERT INTO organizations (business_number, legal_name, organization_type, province, public_profile)
      VALUES ($1,$2,$3,$4,$5::jsonb)
      ON CONFLICT (business_number) DO UPDATE SET
        legal_name = EXCLUDED.legal_name,
        province = COALESCE(EXCLUDED.province, organizations.province),
        organization_type = CASE WHEN EXCLUDED.organization_type='foundation' THEN 'foundation' ELSE organizations.organization_type END,
        public_profile = organizations.public_profile || EXCLUDED.public_profile,
        updated_at = now()
      RETURNING *
    `, [bn, legalName, organizationType, profile.province || null, JSON.stringify(profile)]);
    return rows[0];
  }

  async createVentureOrganizationClaim({ actor, legalName, organizationType, province, evidence = {}, idempotencyKey }) {
    if (!actor?.id) throw new Error('Authenticated actor is required.');
    const name = String(legalName || '').trim();
    const type = String(organizationType || '').trim();
    const normalizedProvince = String(province || '').trim().toUpperCase();
    if (name.length < 2 || name.length > 500) throw new Error('Venture legal name must be between 2 and 500 characters.');
    if (!['non_qualified_donee', 'other'].includes(type)) throw new Error('Venture organizationType must be non_qualified_donee or other.');
    if (!/^[A-Z]{2,3}$/.test(normalizedProvince)) throw new Error('Venture province must be a two- or three-letter code.');
    const replayKey = String(idempotencyKey || '').trim();
    if (!replayKey) throw new Error('idempotencyKey is required.');

    return withTransaction(this.pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`venture-claim:${replayKey}`]);
      const existing = await client.query(`
        SELECT c.*,o.legal_name,o.organization_type,o.province
        FROM recipient_claims c JOIN organizations o ON o.id=c.organization_id
        WHERE c.idempotency_key=$1 FOR UPDATE OF c
      `, [replayKey]);
      if (existing.rows[0]) {
        const replay = existing.rows[0];
        if (replay.claimed_by !== actor.id || replay.legal_name !== name
          || replay.organization_type !== type || replay.province !== normalizedProvince) {
          throw new Error('idempotencyKey was already used with different venture claim inputs.');
        }
        return replay;
      }

      const organization = (await client.query(`
        INSERT INTO organizations (legal_name,organization_type,province,public_profile)
        VALUES ($1,$2,$3,$4::jsonb) RETURNING *
      `, [name, type, normalizedProvince, JSON.stringify({ claimantProvided: true })])).rows[0];
      const claim = (await client.query(`
        INSERT INTO recipient_claims
          (organization_id,claimed_by,status,evidence,idempotency_key,requested_role)
        VALUES ($1,$2,'pending',$3::jsonb,$4,'recipient_admin') RETURNING *
      `, [organization.id, actor.id, JSON.stringify(evidence || {}), replayKey])).rows[0];
      await this.#appendAudit(client, {
        actor,
        organizationId: organization.id,
        action: 'recipient_claim.create_venture',
        resourceType: 'recipient_claim',
        resourceId: claim.id,
        requestId: replayKey,
        payload: { legalName: name, organizationType: type, province: normalizedProvince, evidence }
      });
      return claim;
    });
  }

  async createOrganizationClaim({ actor, organizationId, requestedRole, evidence = {}, idempotencyKey }) {
    return withTransaction(this.pool, async client => {
      const existing = await client.query('SELECT * FROM recipient_claims WHERE idempotency_key = $1', [idempotencyKey]);
      if (existing.rows[0]) return existing.rows[0];
      const { rows } = await client.query(`
        INSERT INTO recipient_claims (organization_id, claimed_by, status, evidence, idempotency_key, requested_role)
        VALUES ($1,$2,'pending',$3::jsonb,$4,$5) RETURNING *
      `, [organizationId, actor.id, JSON.stringify(evidence), idempotencyKey, requestedRole]);
      await this.#appendAudit(client, {
        actor, organizationId, action: 'recipient_claim.create', resourceType: 'recipient_claim',
        resourceId: rows[0].id, requestId: idempotencyKey, payload: { organizationId, requestedRole, evidence }
      });
      return rows[0];
    });
  }

  async verifyRecipientClaim({ actor, claimId, approved, verificationMethod, evidence = {}, idempotencyKey }) {
    return withTransaction(this.pool, async client => {
      const { rows } = await client.query('SELECT * FROM recipient_claims WHERE id = $1 FOR UPDATE', [claimId]);
      const claim = rows[0];
      if (!claim) throw new Error('Recipient claim not found.');
      const nextStatus = approved ? 'verified' : 'rejected';
      const updated = await client.query(`
        UPDATE recipient_claims SET status=$2, verification_method=$3,
          evidence = evidence || $4::jsonb, verified_at = CASE WHEN $2='verified' THEN now() ELSE verified_at END
        WHERE id=$1 RETURNING *
      `, [claimId, nextStatus, verificationMethod, JSON.stringify(evidence)]);
      if (approved) {
        await client.query(`
          INSERT INTO memberships (user_id, organization_id, role)
          VALUES ($1,$2,$3) ON CONFLICT DO NOTHING
        `, [claim.claimed_by, claim.organization_id, claim.requested_role]);
      }
      await this.#appendAudit(client, {
        actor, organizationId: claim.organization_id, action: `recipient_claim.${nextStatus}`,
        resourceType: 'recipient_claim', resourceId: claimId, requestId: idempotencyKey,
        payload: { approved, verificationMethod, evidence }
      });
      return updated.rows[0];
    });
  }

  async grantMembershipBySubject({ actor, userSubject, organizationId, role, idempotencyKey }) {
    return withTransaction(this.pool, async client => {
      const user = await client.query('SELECT id FROM users WHERE oidc_subject=$1', [userSubject]);
      if (!user.rows[0]) throw new Error('Target user must authenticate at least once before a role can be granted.');
      await client.query('INSERT INTO memberships (user_id, organization_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [user.rows[0].id, organizationId, role]);
      await this.#appendAudit(client, {
        actor, organizationId, action: 'membership.grant', resourceType: 'membership',
        resourceId: `${user.rows[0].id}:${organizationId}:${role}`, requestId: idempotencyKey,
        payload: { userSubject, organizationId, role }
      });
      return { userId: user.rows[0].id, userSubject, organizationId, role };
    });
  }

  async createGrant({ actor, foundationOrgId, recipientOrgId, amountCad, purpose, recipientType, idempotencyKey }) {
    return withTransaction(this.pool, async client => {
      const existing = await client.query('SELECT * FROM grants WHERE creation_idempotency_key = $1', [idempotencyKey]);
      if (existing.rows[0]) return grantFromRow(existing.rows[0]);
      const { rows } = await client.query(`
        INSERT INTO grants
          (foundation_org_id, recipient_org_id, amount_cad, purpose, recipient_type, creation_idempotency_key)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
      `, [foundationOrgId, recipientOrgId, amountCad, purpose, recipientType, idempotencyKey]);
      await this.#appendAudit(client, {
        actor, organizationId: foundationOrgId, action: 'grant.create_draft', resourceType: 'grant',
        resourceId: rows[0].id, requestId: idempotencyKey,
        payload: { recipientOrgId, amountCad, purpose, recipientType }
      });
      return grantFromRow(rows[0]);
    });
  }

  async getGrant(grantId) {
    const client = await this.pool.connect();
    try { return await grantDetailed(client, grantId); } finally { client.release(); }
  }

  async listGrants({ organizationIds = [], includeAll = false, limit = 50 }) {
    const params = [Math.min(Math.max(limit, 1), 200)];
    let where = '';
    if (!includeAll) {
      if (!organizationIds.length) return [];
      params.push(organizationIds);
      where = 'WHERE foundation_org_id = ANY($2::uuid[]) OR recipient_org_id = ANY($2::uuid[])';
    }
    const { rows } = await this.pool.query(`SELECT * FROM grants ${where} ORDER BY created_at DESC LIMIT $1`, params);
    return rows.map(grantFromRow);
  }

  async transitionGrantState({ grantId, nextState, actor, input, options = {} }) {
    if (!input?.idempotencyKey) throw new Error('idempotencyKey is required for grant transitions.');
    return withTransaction(this.pool, async client => {
      const previousEvent = await client.query('SELECT grant_id FROM grant_events WHERE idempotency_key = $1', [input.idempotencyKey]);
      if (previousEvent.rows[0]) return grantDetailed(client, previousEvent.rows[0].grant_id);

      const grant = await grantDetailed(client, grantId, { forUpdate: true });
      if (!grant) throw new Error('Grant not found.');
      const next = transitionGrant(grant, nextState, actor, input, options);
      const sets = ['state=$2', 'updated_at=$3'];
      const values = [grantId, next.state, next.updatedAt];
      let index = 4;
      const add = (sql, value) => { sets.push(sql.replace('?', `$${index++}`)); values.push(value); };

      if (nextState === GRANT_STATES.PROPOSED) add('proposed_by=?', actor.id);
      if (nextState === GRANT_STATES.APPROVED) add('approved_by=?', actor.id);
      if (nextState === GRANT_STATES.OFFERED) {
        add('terms_version=?', input.termsVersion);
        add('terms_digest=?', payloadDigest({ termsText: input.termsText || '' }));
        add('terms_text=?', input.termsText);
        add('offered_at=?', next.updatedAt);
      }
      if (nextState === GRANT_STATES.ACCEPTED) add('accepted_by=?', actor.id);
      await client.query(`UPDATE grants SET ${sets.join(', ')} WHERE id=$1`, values);

      if (nextState === GRANT_STATES.ACCEPTED) {
        await client.query(`
          INSERT INTO recipient_consents (grant_id, user_id, terms_version, accepted, metadata)
          VALUES ($1,$2,$3,true,$4::jsonb)
        `, [grantId, actor.id, input.termsVersion, JSON.stringify({ idempotencyKey: input.idempotencyKey })]);
      }
      if (nextState === GRANT_STATES.PAYMENT_AUTHORIZED) {
        await client.query(`
          INSERT INTO payment_intents (grant_id, provider, amount_cad, status, authorized_by, authorized_at, idempotency_key)
          VALUES ($1,'manual',$2,'external_execution_required',$3,now(),$4)
          ON CONFLICT (grant_id) DO UPDATE SET status='external_execution_required', authorized_by=EXCLUDED.authorized_by,
            authorized_at=now(), idempotency_key=COALESCE(payment_intents.idempotency_key, EXCLUDED.idempotency_key)
        `, [grantId, grant.amountCad, actor.id, input.idempotencyKey]);
      }
      if (nextState === GRANT_STATES.PAID) {
        const payment = await client.query(`
          UPDATE payment_intents SET status='recorded', external_reference=$2, recorded_at=now()
          WHERE grant_id=$1 RETURNING id
        `, [grantId, input.externalPaymentReference]);
        if (!payment.rows[0]) throw new Error('Manual payment intent not found.');
      }

      await client.query(`
        INSERT INTO grant_events (grant_id, idempotency_key, from_state, to_state, actor_user_id, metadata, occurred_at)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
      `, [grantId, input.idempotencyKey, grant.state, nextState, actor.id, JSON.stringify(input), next.updatedAt]);
      await this.#appendAudit(client, {
        actor, organizationId: grant.foundationOrgId, action: `grant.transition.${nextState}`,
        resourceType: 'grant', resourceId: grantId, requestId: input.idempotencyKey,
        payload: { fromState: grant.state, toState: nextState, input }
      });
      return grantDetailed(client, grantId);
    });
  }

  async recordRecipientStatus({ actor, grantId, source, sourceRecordId, status, assuranceLevel, observedStatus, evidence, verifiedAt, expiresAt, idempotencyKey }) {
    return withTransaction(this.pool, async client => {
      const grant = await grantDetailed(client, grantId, { forUpdate: true });
      if (!grant) throw new Error('Grant not found.');
      const existing = await client.query('SELECT * FROM recipient_status_checks WHERE idempotency_key=$1', [idempotencyKey]);
      if (existing.rows[0]) return existing.rows[0];
      const { rows } = await client.query(`
        INSERT INTO recipient_status_checks
          (organization_id, source, source_record_id, status, assurance_level, observed_status, evidence,
           verified_at, expires_at, checked_by, idempotency_key)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11) RETURNING *
      `, [grant.recipientOrgId, source, sourceRecordId, status, assuranceLevel, observedStatus, JSON.stringify(evidence || {}), verifiedAt, expiresAt || null, actor.id, idempotencyKey]);
      await this.#appendAudit(client, {
        actor, organizationId: grant.foundationOrgId, action: 'recipient_status.record', resourceType: 'recipient_status_check',
        resourceId: rows[0].id, requestId: idempotencyKey,
        payload: { grantId, recipientOrgId: grant.recipientOrgId, source, status, assuranceLevel, observedStatus, verifiedAt }
      });
      return rows[0];
    });
  }

  async recordComplianceReview({ actor, grantId, decision, rationale, idempotencyKey }) {
    return withTransaction(this.pool, async client => {
      const grant = await grantDetailed(client, grantId, { forUpdate: true });
      if (!grant) throw new Error('Grant not found.');
      const existing = await client.query('SELECT * FROM compliance_reviews WHERE idempotency_key=$1', [idempotencyKey]);
      if (existing.rows[0]) return existing.rows[0];
      const { rows } = await client.query(`
        INSERT INTO compliance_reviews (grant_id, reviewer_user_id, decision, rationale, idempotency_key)
        VALUES ($1,$2,$3,$4,$5) RETURNING *
      `, [grantId, actor.id, decision, rationale, idempotencyKey]);
      await client.query('UPDATE grants SET compliance_decision=$2, updated_at=now() WHERE id=$1', [grantId, decision]);
      await this.#appendAudit(client, {
        actor, organizationId: grant.foundationOrgId, action: 'compliance.review', resourceType: 'grant',
        resourceId: grantId, requestId: idempotencyKey, payload: { decision, rationale }
      });
      return rows[0];
    });
  }

  async fiscalPeriodPaidGrants({ foundationOrgId, periodStart, periodEnd }) {
    const { rows } = await this.pool.query(`
      SELECT g.recipient_org_id, g.amount_cad
      FROM grants g JOIN payment_intents p ON p.grant_id=g.id
      WHERE g.foundation_org_id=$1 AND p.status='recorded' AND p.recorded_at >= $2::timestamptz AND p.recorded_at < ($3::date + interval '1 day')
    `, [foundationOrgId, periodStart, periodEnd]);
    return rows.map(row => ({ recipientOrgId: row.recipient_org_id, amountCad: Number(row.amount_cad) }));
  }

  async upsertReportingRecord({ actor, grantId, fiscalYear, route, t1441Required, payload, t3010Version, idempotencyKey }) {
    return withTransaction(this.pool, async client => {
      const grant = await grantDetailed(client, grantId, { forUpdate: true });
      if (!grant) throw new Error('Grant not found.');
      const { rows } = await client.query(`
        INSERT INTO reporting_records (grant_id, fiscal_year, reporting_route, t3010_version, t1441_required, payload, status)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,'ready')
        ON CONFLICT (grant_id, fiscal_year) DO UPDATE SET
          reporting_route=EXCLUDED.reporting_route, t3010_version=EXCLUDED.t3010_version,
          t1441_required=EXCLUDED.t1441_required, payload=EXCLUDED.payload, status='ready', updated_at=now()
        RETURNING *
      `, [grantId, fiscalYear, route, t3010Version || null, t1441Required, JSON.stringify(payload)]);
      await this.#appendAudit(client, {
        actor, organizationId: grant.foundationOrgId, action: 'reporting.prepare', resourceType: 'reporting_record',
        resourceId: rows[0].id, requestId: idempotencyKey,
        payload: { grantId, fiscalYear, route, t1441Required }
      });
      return rows[0];
    });
  }

  async queueNotification({ actor, grantId, channel, recipient, template, payload = {}, idempotencyKey }) {
    return withTransaction(this.pool, async client => {
      const grant = await grantDetailed(client, grantId, { forUpdate: true });
      if (!grant) throw new Error('Grant not found.');
      const existing = await client.query('SELECT * FROM notification_outbox WHERE idempotency_key=$1', [idempotencyKey]);
      if (existing.rows[0]) return { ...existing.rows[0], recipient: '[encrypted]' };
      const encryptedRecipient = encryptText(recipient, this.encryptionKey);
      const { rows } = await client.query(`
        INSERT INTO notification_outbox (grant_id, channel, recipient, template, payload, idempotency_key)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING *
      `, [grantId, channel, encryptedRecipient, template, JSON.stringify(payload), idempotencyKey]);
      await this.#appendAudit(client, {
        actor, organizationId: grant.foundationOrgId, action: 'notification.queue', resourceType: 'notification',
        resourceId: rows[0].id, requestId: idempotencyKey,
        payload: { grantId, channel, template }
      });
      return { ...rows[0], recipient: '[encrypted]' };
    });
  }

  redactTestNotification(row) {
    const destination = decryptText(row.recipient, this.encryptionKey);
    return {
      id: row.id,
      channel: row.channel,
      destination: maskTestDestination(row.channel, destination),
      subject: row.subject || '',
      status: row.status,
      attempts: Number(row.attempts || 0),
      retryLimit: 3,
      createdAt: row.created_at?.toISOString?.() || row.created_at,
      sentAt: row.sent_at?.toISOString?.() || row.sent_at || null,
      providerMessageId: row.provider_message_id || null,
      lastError: row.last_error || null
    };
  }

  async queueTestNotification({ actor, notification, idempotencyKey }) {
    return withTransaction(this.pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`admin-test:${actor.id}`]);
      const storedKey = `admin-test:${actor.id}:${idempotencyKey}`;
      const requestSignature = crypto.createHmac('sha256', this.auditHmacKey)
        .update('admin-test-notification-request:v1\0')
        .update(notification.requestDigest)
        .digest('hex');
      const existing = (await client.query(
        "SELECT * FROM notification_outbox WHERE template='admin_test' AND idempotency_key=$1",
        [storedKey]
      )).rows[0];
      if (existing) {
        if (existing.payload?.requestSignature !== requestSignature) {
          throw new Error('Idempotency key was already used for different test notification semantics.');
        }
        return this.redactTestNotification(existing);
      }
      const recent = Number((await client.query(
        "SELECT count(*) AS n FROM notification_outbox WHERE template='admin_test' AND created_by=$1 AND created_at > now()-interval '1 hour'",
        [actor.id]
      )).rows[0].n);
      if (recent >= 5) throw new Error('An administrator may queue at most five test notifications per hour.');
      const encrypted = encryptText(notification.destination, this.encryptionKey);
      const auditRequestId = `admin-test:${crypto.createHmac('sha256', this.auditHmacKey).update(storedKey).digest('hex')}`;
      const row = (await client.query(`
        INSERT INTO notification_outbox
          (grant_id,channel,recipient,template,payload,subject,idempotency_key,created_by)
        VALUES (NULL,$1,$2,'admin_test',$3::jsonb,$4,$5,$6)
        RETURNING *
      `, [notification.channel, encrypted, JSON.stringify({
        message: notification.message,
        requestSignature
      }), notification.subject || null, storedKey, actor.id])).rows[0];
      await this.#appendAudit(client, {
        actor,
        organizationId: null,
        action: 'notification.test_queued',
        resourceType: 'notification',
        resourceId: row.id,
        requestId: auditRequestId,
        payload: { channel: notification.channel, template: 'admin_test' }
      });
      return this.redactTestNotification(row);
    });
  }

  async getTestNotificationStatus({ actor, notificationId }) {
    const { rows } = await this.pool.query(`
      SELECT * FROM notification_outbox
      WHERE id=$1 AND template='admin_test' AND created_by=$2
    `, [notificationId, actor.id]);
    if (!rows[0]) throw new Error('Test notification not found.');
    return this.redactTestNotification(rows[0]);
  }

  async claimQueuedNotifications(limit = 25, lockToken, { channels = ['email', 'sms', 'voice'], notificationIds = null } = {}) {
    if (!lockToken) throw new Error('lockToken is required.');
    if (!channels.length || (Array.isArray(notificationIds) && !notificationIds.length)) return [];
    return withTransaction(this.pool, async client => {
      const selected = await client.query(`
        SELECT id FROM notification_outbox
        WHERE status='queued' AND (locked_at IS NULL OR locked_at < now() - interval '5 minutes')
          AND channel = ANY($2::text[])
          AND ($3::uuid[] IS NULL OR id = ANY($3::uuid[]))
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $1
      `, [Math.min(Math.max(limit, 1), 100), channels, notificationIds]);
      if (!selected.rows.length) return [];
      const ids = selected.rows.map(row => row.id);
      const { rows } = await client.query(`
        UPDATE notification_outbox SET locked_at=now(), lock_token=$2, attempts=attempts+1
        WHERE id = ANY($1::uuid[]) RETURNING *
      `, [ids, lockToken]);
      return rows.sort((a,b) => new Date(a.created_at) - new Date(b.created_at));
    });
  }

  async markNotificationSent(notificationId, providerMessageId, lockToken) {
    return withTransaction(this.pool, async client => {
      const current = await client.query(`SELECT n.*, g.foundation_org_id FROM notification_outbox n LEFT JOIN grants g ON g.id=n.grant_id WHERE n.id=$1 FOR UPDATE OF n`, [notificationId]);
      if (!current.rows[0] || current.rows[0].status !== 'queued' || current.rows[0].lock_token !== lockToken) return null;
      const { rows } = await client.query(`
        UPDATE notification_outbox SET status='sent', provider_message_id=$2, sent_at=now(), last_error=NULL, locked_at=NULL, lock_token=NULL
        WHERE id=$1 RETURNING *
      `, [notificationId, providerMessageId || null]);
      await this.#appendAudit(client, {
        actor: null, organizationId: current.rows[0].foundation_org_id, action: 'notification.sent', resourceType: 'notification',
        resourceId: notificationId, requestId: lockToken, payload: { providerMessageId: providerMessageId || null }
      });
      return rows[0];
    });
  }

  async markNotificationFailed(notificationId, errorMessage, lockToken, retry = false) {
    return withTransaction(this.pool, async client => {
      const current = await client.query(`SELECT n.*, g.foundation_org_id FROM notification_outbox n LEFT JOIN grants g ON g.id=n.grant_id WHERE n.id=$1 FOR UPDATE OF n`, [notificationId]);
      if (!current.rows[0] || current.rows[0].status !== 'queued' || current.rows[0].lock_token !== lockToken) return null;
      const nextStatus = retry ? 'queued' : 'failed';
      let error = String(errorMessage);
      let destination = String(current.rows[0].recipient || '');
      try {
        destination = decryptText(destination, this.encryptionKey);
      } catch {
        // Retain the stored value as a redaction candidate for legacy plaintext rows.
      }
      if (destination) error = error.split(destination).join('[redacted-destination]');
      error = error.slice(0, 1000);
      const { rows } = await client.query(`
        UPDATE notification_outbox SET status=$2, last_error=$3, locked_at=NULL, lock_token=NULL
        WHERE id=$1 RETURNING *
      `, [notificationId, nextStatus, error]);
      await this.#appendAudit(client, {
        actor: null, organizationId: current.rows[0].foundation_org_id, action: retry ? 'notification.retry' : 'notification.failed',
        resourceType: 'notification', resourceId: notificationId, requestId: lockToken,
        payload: { retry }
      });
      return rows[0];
    });
  }

  async markReportingRecordFiled({ actor, reportingRecordId, submissionReference, idempotencyKey }) {
    return withTransaction(this.pool, async client => {
      const current = await client.query(`SELECT r.*, g.foundation_org_id FROM reporting_records r JOIN grants g ON g.id=r.grant_id WHERE r.id=$1 FOR UPDATE OF r`, [reportingRecordId]);
      if (!current.rows[0]) throw new Error('Reporting record not found.');
      if (current.rows[0].status === 'filed') return current.rows[0];
      const payload = { ...(current.rows[0].payload || {}), submissionReference, submissionRecordedAt: new Date().toISOString() };
      const { rows } = await client.query(`UPDATE reporting_records SET status='filed', payload=$2::jsonb, updated_at=now() WHERE id=$1 RETURNING *`, [reportingRecordId, JSON.stringify(payload)]);
      await this.#appendAudit(client, {
        actor, organizationId: current.rows[0].foundation_org_id, action: 'reporting.filed_recorded', resourceType: 'reporting_record',
        resourceId: reportingRecordId, requestId: idempotencyKey, payload: { submissionReference }
      });
      return rows[0];
    });
  }

  async getReportingRecord(reportingRecordId) {
    const { rows } = await this.pool.query('SELECT * FROM reporting_records WHERE id=$1', [reportingRecordId]);
    return rows[0] || null;
  }
}
