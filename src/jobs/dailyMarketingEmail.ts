import cron from 'node-cron';
import { sendDailyMarketingEmail } from '../services/email.service.js';
import { isSmsAutomationEnabled } from '../services/sms-automation.service.js';

export function startDailyMarketingCron() {
  // 8:00 AM Tanzania time (EAT = UTC+3) = 05:00 UTC
  cron.schedule('0 5 * * *', async () => {
    if (!(await isSmsAutomationEnabled('daily_marketing_email'))) {
      console.log('[cron] Daily marketing email paused by developer — skipped');
      return;
    }
    console.log('[cron] Running daily marketing email...');
    try {
      const result = await sendDailyMarketingEmail();
      console.log(`[cron] Daily marketing email result:`, result);
    } catch (e: any) {
      console.error('[cron] Daily marketing email error:', e.message);
    }
  });

  console.log('[cron] Daily marketing email job registered (8:00 AM EAT)');
}
