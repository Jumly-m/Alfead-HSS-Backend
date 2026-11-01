import cron from 'node-cron';
import { adminSyncSenderStatuses } from '../services/sms-reseller.service.js';

// Pulls sender-ID decisions from eHub on a schedule (approved / rejected + the
// provider's exact reason). Runs in the background so:
//   • the provider's response message lands in the ALFEAN ENTERPRISES portal by itself, and
//   • the applicant is notified (SMS + email) with that reason in real time,
// without the developer having to click "Sync from Provider".
export function startSenderIdStatusSyncCron() {
  const run = async () => {
    try {
      const res: any = await adminSyncSenderStatuses();
      if (res?.offline) return; // provider unreachable — try again next tick
      if ((res?.updated || 0) > 0 || (res?.notified || 0) > 0) {
        console.log(`[cron] Sender ID sync: synced=${res.synced} updated=${res.updated} notified=${res.notified}`);
      }
    } catch (e: any) {
      console.error('[cron] Sender ID sync error:', e.message);
    }
  };

  // First pass shortly after boot (provider needs a moment), then every 5 min.
  setTimeout(run, 15_000);
  cron.schedule('*/5 * * * *', run);
  console.log('[cron] Sender ID status sync registered (every 5 min)');
}
