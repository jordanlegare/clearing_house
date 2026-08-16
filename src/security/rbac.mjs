export const ROLES = Object.freeze({
  SYSTEM_ADMIN: 'system_admin',
  FOUNDATION_ANALYST: 'foundation_analyst',
  FOUNDATION_APPROVER: 'foundation_approver',
  COMPLIANCE_REVIEWER: 'compliance_reviewer',
  RECIPIENT_ADMIN: 'recipient_admin',
  PAYMENT_OPERATOR: 'payment_operator',
  AUDITOR: 'auditor'
});

export const PERMISSIONS = Object.freeze({
  READ_PUBLIC: 'read_public',
  READ_PRIVATE_ORG: 'read_private_org',
  PROPOSE_GRANT: 'propose_grant',
  APPROVE_GRANT: 'approve_grant',
  OFFER_GRANT: 'offer_grant',
  ACCEPT_GRANT: 'accept_grant',
  DECLINE_GRANT: 'decline_grant',
  REVIEW_COMPLIANCE: 'review_compliance',
  AUTHORIZE_PAYMENT: 'authorize_payment',
  RECORD_PAYMENT: 'record_payment',
  MARK_REPORTED: 'mark_reported',
  MANAGE_IDENTITY: 'manage_identity',
  EXPORT_REPORTING: 'export_reporting',
  AUDIT_READ: 'audit_read'
});

const rolePermissions = new Map([
  [ROLES.SYSTEM_ADMIN, new Set(Object.values(PERMISSIONS))],
  [ROLES.FOUNDATION_ANALYST, new Set([PERMISSIONS.READ_PUBLIC, PERMISSIONS.READ_PRIVATE_ORG, PERMISSIONS.PROPOSE_GRANT])],
  [ROLES.FOUNDATION_APPROVER, new Set([PERMISSIONS.READ_PUBLIC, PERMISSIONS.READ_PRIVATE_ORG, PERMISSIONS.APPROVE_GRANT, PERMISSIONS.OFFER_GRANT, PERMISSIONS.EXPORT_REPORTING])],
  [ROLES.COMPLIANCE_REVIEWER, new Set([PERMISSIONS.READ_PUBLIC, PERMISSIONS.READ_PRIVATE_ORG, PERMISSIONS.REVIEW_COMPLIANCE, PERMISSIONS.EXPORT_REPORTING, PERMISSIONS.AUDIT_READ])],
  [ROLES.RECIPIENT_ADMIN, new Set([PERMISSIONS.READ_PUBLIC, PERMISSIONS.READ_PRIVATE_ORG, PERMISSIONS.ACCEPT_GRANT, PERMISSIONS.DECLINE_GRANT, PERMISSIONS.MANAGE_IDENTITY])],
  [ROLES.PAYMENT_OPERATOR, new Set([PERMISSIONS.READ_PRIVATE_ORG, PERMISSIONS.AUTHORIZE_PAYMENT, PERMISSIONS.RECORD_PAYMENT, PERMISSIONS.AUDIT_READ])],
  [ROLES.AUDITOR, new Set([PERMISSIONS.READ_PUBLIC, PERMISSIONS.READ_PRIVATE_ORG, PERMISSIONS.AUDIT_READ, PERMISSIONS.EXPORT_REPORTING])]
]);

export function hasPermission(roles = [], permission) {
  return roles.some(role => rolePermissions.get(role)?.has(permission));
}

export function requirePermission(actor, permission) {
  if (!actor?.id) throw new Error('Authenticated actor is required.');
  if (!hasPermission(actor.roles || [], permission)) throw new Error(`Actor ${actor.id} lacks permission ${permission}.`);
  return true;
}
