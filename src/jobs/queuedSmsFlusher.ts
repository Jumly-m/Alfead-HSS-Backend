import cron from 'node-cron';
import { flushQueuedSms } from '../services/sms-reseller.service.js';

// Drains the queued SMS backlog whenever the provider float has balance. Runs
// every 2 minutes so sends user-typed during a provider-outage window are
// delivered promptly once the developer tops up the wallet.
export function startQueuedSmsFlusher() {
  cron.schedule('*/2 * * * *', async () => {
    try {
      const res = await flushQueuedSms();
      if (res.sent > 0 || res.failed > 0) {
        console.log(`[cron] Queued SMS flush: sent=${res.sent} failed=${res.failed} remaining=${res.remaining}`);
      }
    } catch (e: any) {
      console.error('[cron] Queued SMS flusher error:', e.message);
    }
  });
  console.log('[cron] Queued SMS flusher registered (every 2 min)');
}