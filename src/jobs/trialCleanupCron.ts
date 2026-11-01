import cron from 'node-cron';
import { runTrialCleanup } from '../services/trial-cleanup.service.js';

/**
 * Free-trial cleanup — runs daily at 09:30 server time.
 *
 * Sends the 3-day deletion warning (email + SMS) to abandoned trials, then
 * deletes accounts whose trial expired 20+ days ago that never paid and have
 * no active subscription — only after the warning has had its full 3 days.
 * The whole job can be turned off from the developer dashboard
 * (system_settings.trial_cleanup_settings.enabled).
 */
export function startTrialCleanupCron() {
  cron.schedule('30 9 * * *', async () => {
    console.log('[cron] Running free-trial cleanup...');
    try {
      const result = await runTrialCleanup();
      if (!result.enabled) {
        console.log('[cron] Free-trial cleanup disabled in settings — skipped');
        return;
      }
      console.log(`[cron] Free-trial cleanup: ${result.warningsSent} warning(s) sent, ${result.deleted} account(s) deleted`);
    } catch (e: any) {
      console.error('[cron] Free-trial cleanup error:', e.message);
    }
  });

  console.log('[cron] Free-trial cleanup job registered');
}
