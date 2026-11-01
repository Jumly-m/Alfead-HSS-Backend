/**
 * =====================================================
 * LEADER LEASE — single-writer for background jobs
 * =====================================================
 *
 * ALFEAN ENTERPRISES starts several cron jobs (subscription expiry, marketing email, SMS
 * campaigns, backups, payment follow-ups…). If the app is scaled to multiple
 * replicas (Coolify / PM2 cluster / multiple containers), every instance would
 * otherwise run these jobs and send duplicate emails / double-charge expiry.
 *
 * This module uses a PostgreSQL session-level advisory lock so that only ONE
 * instance runs the background jobs at a time. The lock is held for the whole
 * lifetime of the process by keeping the underlying pool connection open. If
 * the leader crashes, its connection drops and the lock is released, allowing
 * another replica to take over automatically — no TTL renewal needed.
 *
 * Single-instance deployments are unaffected: with only one app process the
 * lock is always acquired on the first try.
 */

import { pool } from '../config/drizzle.js';

// Fixed 64-bit advisory-lock key so every ALFEAN ENTERPRISES replica contends for the SAME
// lock. Value is derived from "JBPOS" and fits in PostgreSQL's bigint.
const LEADER_LOCK_KEY = 310474625363; // 0x4853504F53

// Keep the checked-out connection referenced so it is never garbage-collected;
// releasing (or GC) would drop the advisory lock and a second replica could
// take over while this one still thinks it is the leader.
let leaseClient: any = null;

/**
 * Attempt to become the background-job leader.
 *
 * @returns `true`  → this instance holds the lease; start background jobs.
 *          `false` → another instance already holds it; skip background jobs.
 *
 * On a database error we log a warning and return `true`. A transient DB
 * hiccup on a single-instance deploy must never silently disable backups and
 * crons; only a clean `false` from the database means "someone else is leader".
 */
export async function acquireLeaderLease(): Promise<boolean> {
  try {
    leaseClient = await pool.connect();
    const res = await leaseClient.query(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [LEADER_LOCK_KEY]
    );
    const locked = res.rows[0]?.locked === true;
    if (!locked) {
      try { leaseClient.release(); } catch { /* ignore */ }
      leaseClient = null;
    }
    return locked;
  } catch (e: any) {
    console.warn('[Leader] Advisory lock unavailable, assuming single instance:', e.message);
    if (leaseClient) {
      try { leaseClient.release(); } catch { /* ignore */ }
      leaseClient = null;
    }
    return true;
  }
}
