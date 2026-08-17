import test from 'node:test';
import assert from 'node:assert/strict';
import { jobDefinitions } from '../src/automation/scheduler.mjs';

test('autonomous job definitions preserve safety boundaries and configured cadence', () => {
  const jobs = jobDefinitions({
    automationEnabled: true,
    notificationProvider: 'twilio',
    notificationPollSeconds: 45,
    enableT3010Sync: true,
    t3010SyncIntervalHours: 12
  });
  const byName = Object.fromEntries(jobs.map(job => [job.name, job]));
  assert.equal(byName.notifications.enabled, true);
  assert.equal(byName.notifications.intervalSeconds, 45);
  assert.equal(byName.t3010_sync.enabled, true);
  assert.equal(byName.t3010_sync.intervalSeconds, 43_200);
  assert.equal(byName.maintenance.enabled, true);
  assert.equal(byName.maintenance.intervalSeconds, 300);
});

test('autonomous jobs disable external work when the parent feature is off', () => {
  const jobs = jobDefinitions({
    automationEnabled: false,
    notificationProvider: 'twilio',
    notificationPollSeconds: 30,
    enableT3010Sync: true,
    t3010SyncIntervalHours: 24
  });
  assert.ok(jobs.every(job => job.enabled === false));
});

test('email-only delivery enables offer batches and notification dispatch', () => {
  const jobs = jobDefinitions({
    automationEnabled:true,
    enableWorkflowWrites:true,
    recipientPortalEnabled:true,
    notificationProvider:'disabled',
    emailProvider:'resend',
    notificationPollSeconds:30,
    automatedPortfoliosEnabled:false,
    allocationPolicyPollSeconds:300,
    enableT3010Sync:false,
    t3010SyncIntervalHours:24
  });
  const byName = Object.fromEntries(jobs.map(job => [job.name, job]));
  assert.equal(byName.notifications.enabled, true);
  assert.equal(byName.offer_batches.enabled, true);
});

test('delivery jobs remain disabled only when both provider families are disabled', () => {
  const jobs = jobDefinitions({
    automationEnabled:true,
    enableWorkflowWrites:true,
    recipientPortalEnabled:true,
    notificationProvider:'disabled',
    emailProvider:'disabled',
    notificationPollSeconds:30,
    automatedPortfoliosEnabled:false,
    allocationPolicyPollSeconds:300,
    enableT3010Sync:false,
    t3010SyncIntervalHours:24
  });
  const byName = Object.fromEntries(jobs.map(job => [job.name, job]));
  assert.equal(byName.notifications.enabled, false);
  assert.equal(byName.offer_batches.enabled, false);
});
