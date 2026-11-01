import cron from 'node-cron';
import { pool } from '../config/drizzle.js';
import * as ehub from '../services/ehub-sms.service.js';

// Polls eHub for the delivery outcome of recently-sent SMS and writes the
// provider's answer (delivered / failed + its reason) back onto sms_messages
// and sms_log. This is the pull-side complement to the eHub delivery webhook:
// even when the webhook is not configured (or a callback is missed), SMS
// History / Monitoring updates itself automatically.
const BATCH = 40;
const LOOKBACK_DAYS = 3;

function mapProviderStatus(raw: string): string | null {
  const s = String(raw || '').toLowerCase();
  if (['delivered', 'completed'].includes(s)) return 'delivered';
  if (['failed', 'undelivered', 'rejected', 'expired', 'error'].includes(s)) return 'failed';
  return null; // sent / queued / pending — not terminal yet
}

function extractReason(data: any): string | null {
  const raw = data?.error ?? data?.reason ?? data?.failure_reason ?? data?.error_message
    ?? data?.message ?? data?.note ?? null;
  const s = raw == null ? '' : String(raw).trim();
  return s && s.toLowerCase() !== 'null' ? s.slice(0, 500) : null;
}

async function syncShopMessages(): Promise<number> {
  const rows = await pool.query(
    `SELECT id, provider_message_id, status FROM sms_messages
     WHERE provider_message_id IS NOT NULL AND provider_message_id <> ''
       AND status IN ('queued', 'sent', 'pending')
       AND created_at > NOW() - ($1 || ' days')::interval
     ORDER BY created_at DESC
     LIMIT $2`,
    [String(LOOKBACK_DAYS), BATCH]
  );
  let updated = 0;
  for (const row of rows.rows) {
    try {
      const data = await ehub.getMessageStatus(row.provider_message_id);
      const newStatus = mapProviderStatus(data?.status || data?.delivery_status || data?.state);
      if (!newStatus || newStatus === row.status) continue;
      const reason = extractReason(data);
      await pool.query(
        `UPDATE sms_messages SET status = $2, error = COALESCE($3, error) WHERE id = $1`,
        [row.id, newStatus, reason]
      );
      updated++;
    } catch {
      // Provider unreachable / unknown message id — try again next run.
    }
  }
  return updated;
}

async function syncSystemLog(): Promise<number> {
  const rows = await pool.query(
    `SELECT id, message_id, status FROM sms_log
     WHERE message_id IS NOT NULL AND message_id <> ''
       AND status IN ('queued', 'sent')
       AND created_at > NOW() - ($1 || ' days')::interval
     ORDER BY created_at DESC
     LIMIT $2`,
    [String(LOOKBACK_DAYS), BATCH]
  );
  let updated = 0;
  for (const row of rows.rows) {
    try {
      const data = await ehub.getMessageStatus(row.message_id);
      const newStatus = mapProviderStatus(data?.status || data?.delivery_status || data?.state);
      if (!newStatus || newStatus === row.status) continue;
      const reason = extractReason(data);
      await pool.query(
        `UPDATE sms_log SET status = $2, error_message = COALESCE($3, error_message) WHERE id = $1`,
        [row.id, newStatus === 'failed' ? 'failed' : newStatus, reason]
      );
      updated++;
    } catch {
      // ignore — retried next run
    }
  }
  return updated;
}

export function startSmsDeliverySync() {
  const run = async () => {
    try {
      const [shopUpdated, logUpdated] = await Promise.all([syncShopMessages(), syncSystemLog()]);
      if (shopUpdated > 0 || logUpdated > 0) {
        console.log(`[cron] Delivery sync pulled from provider: shop=${shopUpdated} system=${logUpdated}`);
      }
    } catch (e: any) {
      console.error('[cron] Delivery sync error:', e.message);
    }
  };
  cron.schedule('*/5 * * * *', run);
  console.log('[cron] SMS delivery status sync registered (every 5 min)');
}
