import { withTransaction } from '../db/pool.mjs';

export function jobDefinitions(config) {
  const enabled = Boolean(config.automationEnabled);
  return [
    {
      name: 'allocation_policies',
      enabled: enabled && config.automatedPortfoliosEnabled,
      intervalSeconds: config.allocationPolicyPollSeconds,
      metadata: { purpose: 'Keep pre-authorized foundation allocation envelopes filled with draft grants only.' }
    },
    {
      name: 'review_bundles',
      enabled: enabled && config.automatedPortfoliosEnabled,
      intervalSeconds: config.allocationPolicyPollSeconds,
      metadata: { purpose: 'Recover policy drafts, auto-propose only when pre-authorized, and assemble immutable review bundles.' }
    },
    {
      name: 'offer_batches',
      enabled: enabled && config.enableWorkflowWrites && config.recipientPortalEnabled && config.notificationProvider !== 'disabled',
      intervalSeconds: config.notificationPollSeconds,
      metadata: { purpose: 'Advance approved review bundles through verified recipient contact discovery and grant offering without bypassing recipient consent.' }
    },
    {
      name: 'notifications',
      enabled: enabled && config.notificationProvider !== 'disabled',
      intervalSeconds: config.notificationPollSeconds,
      metadata: { purpose: 'Dispatch and retry queued recipient notifications.' }
    },
    {
      name: 't3010_sync',
      enabled: enabled && config.enableT3010Sync,
      intervalSeconds: config.t3010SyncIntervalHours * 3600,
      metadata: { purpose: 'Refresh CRA T3010/Open Government source data.' }
    },
    {
      name: 'maintenance',
      enabled,
      intervalSeconds: 300,
      metadata: { purpose: 'Recover stale operational locks and retire expired access tokens.' }
    }
  ];
}

export class AutomationScheduler {
  constructor(pool, { leaseSeconds = 300 } = {}) {
    if (!pool) throw new Error('AutomationScheduler requires a database pool.');
    this.pool = pool;
    this.leaseSeconds = leaseSeconds;
  }

  async configureJobs(definitions) {
    for (const definition of definitions) {
      await this.pool.query(`
        INSERT INTO automation_jobs (name, enabled, interval_seconds, metadata)
        VALUES ($1,$2,$3,$4::jsonb)
        ON CONFLICT (name) DO UPDATE SET
          enabled=EXCLUDED.enabled,
          interval_seconds=EXCLUDED.interval_seconds,
          metadata=automation_jobs.metadata || EXCLUDED.metadata,
          updated_at=now()
      `, [definition.name, definition.enabled, definition.intervalSeconds, JSON.stringify(definition.metadata || {})]);
    }
  }

  async heartbeat(workerId, state = 'idle', metadata = {}) {
    await this.pool.query(`
      INSERT INTO automation_worker_heartbeats (worker_id, state, metadata)
      VALUES ($1,$2,$3::jsonb)
      ON CONFLICT (worker_id) DO UPDATE SET
        heartbeat_at=now(), state=EXCLUDED.state,
        metadata=automation_worker_heartbeats.metadata || EXCLUDED.metadata
    `, [workerId, state, JSON.stringify(metadata)]);
  }

  async claimDueJobs(workerId, limit = 4) {
    return withTransaction(this.pool, async client => {
      const selected = await client.query(`
        SELECT name FROM automation_jobs
        WHERE enabled=true
          AND next_run_at <= now()
          AND (locked_until IS NULL OR locked_until < now())
        ORDER BY next_run_at, name
        FOR UPDATE SKIP LOCKED
        LIMIT $1
      `, [Math.min(Math.max(Number(limit) || 1, 1), 20)]);
      const claimed = [];
      for (const row of selected.rows) {
        const result = await client.query(`
          UPDATE automation_jobs SET
            locked_by=$2,
            locked_until=now() + ($3 * interval '1 second'),
            last_started_at=now(),
            last_status='running',
            last_error=NULL,
            updated_at=now()
          WHERE name=$1
          RETURNING *
        `, [row.name, workerId, this.leaseSeconds]);
        claimed.push(result.rows[0]);
      }
      return claimed;
    });
  }

  async complete(jobName, workerId, result = {}, status = 'success') {
    const updated = await this.pool.query(`
      UPDATE automation_jobs SET
        locked_by=NULL,
        locked_until=NULL,
        last_completed_at=now(),
        last_status=$3,
        last_error=NULL,
        last_result=$4::jsonb,
        next_run_at=now() + (interval_seconds * interval '1 second'),
        updated_at=now()
      WHERE name=$1 AND locked_by=$2
      RETURNING *
    `, [jobName, workerId, status, JSON.stringify(result)]);
    if (!updated.rows[0]) throw new Error(`Automation lease for ${jobName} is no longer owned by ${workerId}.`);
    return updated.rows[0];
  }

  async fail(jobName, workerId, error) {
    const message = String(error?.stack || error?.message || error).slice(0, 8000);
    const updated = await this.pool.query(`
      UPDATE automation_jobs SET
        locked_by=NULL,
        locked_until=NULL,
        last_completed_at=now(),
        last_status='failed',
        last_error=$3,
        next_run_at=now() + (LEAST(interval_seconds, 300) * interval '1 second'),
        updated_at=now()
      WHERE name=$1 AND locked_by=$2
      RETURNING *
    `, [jobName, workerId, message]);
    return updated.rows[0] || null;
  }

  async status() {
    const [jobs, workers] = await Promise.all([
      this.pool.query('SELECT * FROM automation_jobs ORDER BY name'),
      this.pool.query("SELECT * FROM automation_worker_heartbeats WHERE heartbeat_at > now() - interval '15 minutes' ORDER BY heartbeat_at DESC")
    ]);
    return { jobs: jobs.rows, activeWorkers: workers.rows };
  }
}
