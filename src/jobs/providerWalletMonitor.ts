import cron from 'node-cron';
import { checkProviderWalletAndAlert } from '../services/sms-reseller.service.js';

// Monitors the eHub provider float every 10 minutes. When it drops below the
// configured threshold (default TZS 20,000), alerts the developer by SMS + email.
// No auto-top-up and no M-Pesa STK push — alerts only.
export function startProviderWalletMonitor() {
  cron.schedule('*/10 * * * *', async () => {
    console.log('[cron] Checking provider SMS wallet balance...');
    try {
      const res = await checkProviderWalletAndAlert();
      if (res.alerted) {
        console.log(`[cron] Provider wallet low alert sent (SMS:${res.smsSent}, email:${res.emailSent}) balance TZS ${res.tzs_balance}`);
      } else if (res.low) {
        console.log(`[cron] Provider wallet low (TZS ${res.tzs_balance}) — alert on cooldown`);
      }
    } catch (e: any) {
      console.error('[cron] Provider wallet monitor error:', e.message);
    }
  });

  console.log('[cron] Provider wallet monitor registered (every 10 min)');
}
