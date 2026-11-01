import cron from 'node-cron';
import { pool } from '../config/drizzle.js';
import { reconcileSmsPurchase } from '../services/sms-reseller.service.js';

// Safety net for missed/late Snippe webhooks: finalize SMS purchases whose
// payment already completed (or expired) even when the customer closed the app
// or the webhook could not be delivered. The webhook is the real-time path;
// this job makes "payment received → credits added" guaranteed within a minute
// so nothing can stay pending forever.
const BATCH = 10;

async function reconcilePending(): Promise<number> {
  const rows = await pool.query(
    `SELECT snippe_reference FROM sms_purchases
     WHERE status = 'pending' AND snippe_reference IS NOT NULL
       AND created_at > NOW() - INTERVAL '6 hours'
     ORDER BY created_at ASC LIMIT $1`,
    [BATCH]
  );
  let finalized = 0;
  for (const row of rows.rows) {
    try {
      const p = await reconcileSmsPurchase(row.snippe_reference);
      if (p && p.status !== 'pending') finalized++;
    } catch { /* keep the others going */ }
  }
  if (finalized > 0) {
    console.log(`[sms-purchase-reconcile] finalized ${finalized} purchase(s) without waiting for a webhook`);
  }
  return finalized;
}

export function startSmsPurchaseReconcileCron() {
  cron.schedule('* * * * *', () => {
    reconcilePending().catch((e: any) =>
      console.warn('[sms-purchase-reconcile] error:', e?.message)
    );
  });
  console.log('⏳ SMS purchase reconcile cron active (every minute)');
}
