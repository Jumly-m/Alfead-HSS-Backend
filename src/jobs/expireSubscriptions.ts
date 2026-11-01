import cron from 'node-cron';
import { pool } from '../config/drizzle.js';
import { sendExpirationReminders, expireSubscriptions, sendTrialExpiringEmails } from '../services/email.service.js';
import { sendTrialExpiringSms, sendSubscriptionExpiringSms } from '../services/sms.service.js';
import { isSmsAutomationEnabled } from '../services/sms-automation.service.js';

export function startSubscriptionCron() {
  cron.schedule('0 9 * * *', async () => {
    console.log('[cron] Checking for expired subscriptions...');
    try {
      const { expired } = await expireSubscriptions();
      if (expired > 0) {
        console.log(`[cron] Expired ${expired} subscription(s)`);
      }
    } catch (e: any) {
      console.error('[cron] Subscription expiry error:', e.message);
    }
  });

  cron.schedule('0 10 * * *', async () => {
    console.log('[cron] Sending subscription expiration reminders...');
    try {
      const { sent } = await sendExpirationReminders();
      console.log(`[cron] Sent ${sent} expiration reminder(s)`);
    } catch (e: any) {
      console.error('[cron] Reminder error:', e.message);
    }
  });

  // Trial expiring emails — runs daily at 11:00 AM
  cron.schedule('0 11 * * *', async () => {
    console.log('[cron] Sending trial expiring reminders...');
    try {
      const result = await sendTrialExpiringEmails();
      console.log(`[cron] Sent ${result.sent} trial-expiring email(s)`);
    } catch (e: any) {
      console.error('[cron] Trial expiring email error:', e.message);
    }
  });

  // Trial expiring SMS — runs daily at 12:00 PM
  cron.schedule('0 12 * * *', async () => {
    if (!(await isSmsAutomationEnabled('trial_expiry_sms'))) {
      console.log('[cron] Trial expiring SMS paused by developer — skipped');
      return;
    }
    console.log('[cron] Sending trial expiring SMS...');
    try {
      const result = await sendTrialExpiringSms();
      console.log(`[cron] Sent ${result.sent}/${result.total} trial-expiring SMS`);
    } catch (e: any) {
      console.error('[cron] Trial expiring SMS error:', e.message);
    }
  });

  // Subscription expiring SMS — runs daily at 13:00 PM
  cron.schedule('0 13 * * *', async () => {
    if (!(await isSmsAutomationEnabled('subscription_expiry_sms'))) {
      console.log('[cron] Subscription expiring SMS paused by developer — skipped');
      return;
    }
    console.log('[cron] Sending subscription expiring SMS...');
    try {
      const result = await sendSubscriptionExpiringSms();
      console.log(`[cron] Sent ${result.sent}/${result.total} subscription-expiring SMS`);
    } catch (e: any) {
      console.error('[cron] Subscription expiring SMS error:', e.message);
    }
  });

  console.log('[cron] Subscription expiry job registered');
  console.log('[cron] Expiration reminder job registered');
  console.log('[cron] Trial expiring reminder job registered');
  console.log('[cron] Trial expiring SMS job registered');
  console.log('[cron] Subscription expiring SMS job registered');
}