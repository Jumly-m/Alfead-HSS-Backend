import cron from 'node-cron';
import { runDebtReminderJob, runInvoiceReminderJob, runDailySalesSummaryJob, runLowStockAlertJob } from '../services/sms-reseller.service.js';
import { isSmsAutomationEnabled } from '../services/sms-automation.service.js';

export function startAutoSmsReminderCron() {
  // Daily 08:00 EAT. Debt + invoice reminders only send when the shop has the
  // matching setting enabled, so this scan is cheap for shops that opt out.
  cron.schedule('0 8 * * *', async () => {
    if (!(await isSmsAutomationEnabled('shop_auto_sms'))) {
      console.log('[cron] Auto SMS reminders paused by developer — skipped');
      return;
    }
    console.log('[cron] Running auto SMS reminders (debt + invoice + low stock)...');
    try {
      const debt = await runDebtReminderJob();
      console.log(`[cron] Debt reminders sent: ${debt.totalSent}`);
    } catch (e: any) {
      console.error('[cron] Debt reminder job error:', e.message);
    }
    try {
      const invoice = await runInvoiceReminderJob();
      console.log(`[cron] Invoice reminders sent: ${invoice.totalSent}`);
    } catch (e: any) {
      console.error('[cron] Invoice reminder job error:', e.message);
    }
  });

  // Low stock alerts run every 5 minutes so owners get notified quickly when
  // stock runs low. The in-job dedupe (sms_messages source='low_stock_alert'
  // per day) keeps it to one SMS per owner per day.
  cron.schedule('*/5 * * * *', async () => {
    if (!(await isSmsAutomationEnabled('shop_auto_sms'))) return; // paused by developer
    console.log('[cron] Checking low stock alerts...');
    try {
      const lowStock = await runLowStockAlertJob();
      console.log(`[cron] Low stock alerts sent: ${lowStock.totalSent}`);
    } catch (e: any) {
      console.error('[cron] Low stock alert job error:', e.message);
    }
  });

  // Daily sales summary runs every 5 minutes and only sends at/after each
  // shop's configured daily_summary_time (e.g. when the shop closes). The
  // in-job dedupe (sms_messages source='daily_summary' per day) keeps it to
  // one SMS per owner per day even if the process restarts.
  cron.schedule('*/5 * * * *', async () => {
    if (!(await isSmsAutomationEnabled('shop_auto_sms'))) return; // paused by developer
    console.log('[cron] Checking daily sales summaries...');
    try {
      const summary = await runDailySalesSummaryJob();
      console.log(`[cron] Daily sales summaries sent: ${summary.totalSent}`);
    } catch (e: any) {
      console.error('[cron] Daily sales summary job error:', e.message);
    }
  });

  console.log('[cron] Auto SMS reminder job registered (daily 08:00 + low stock + summary every 5 min)');
}
