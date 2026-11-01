# Ghala WhatsApp Templates for ALFEAN ENTERPRISES

Every proactive WhatsApp message ALFEAN ENTERPRISES sends must use an **approved template** (WhatsApp
does not allow free-form business-initiated messages outside a 24h session window).
Templates are created in the Ghala dashboard → **Templates**, then reviewed by Meta.

The placeholder order below **must match exactly** what `backend/src/services/ghala-notifications.ts`
expects (`TEMPLATE_CONFIG`), because the code fills `{{1}}`, `{{2}}`, … in order.
The language code must also match what the template was submitted under.

## Created ✅

### 1. `order_confirmation` — UTILITY, Swahili
Sent after a package purchase is confirmed (Snippe webhook → subscription activated).

```
Habari {{1}}, asante kwa ununuzi wako! Umenunua package ya {{2}} kwa TZS {{3}}.
Risiti namba {{4}}. Kifurushi chako kinaanza {{5}} na kinaisha {{6}}.
Ukiwa na changamoto usisite kuwasiliana nasi whatsap number{{7}}. Karibu tena ALFEAN ENTERPRISES-POS
```

| # | Placeholder | Value |
|---|-------------|-------|
| 1 | `tenants.name` | Tenant / shop owner name |
| 2 | `subscriptionPlans.name` | e.g. "3-Month Plan" |
| 3 | `subscriptionPayments.amountTzs` | Amount paid, formatted (e.g. 150,000) |
| 4 | `subscriptionPayments.snippeReference` | Payment reference |
| 5 | `tenantSubscriptions.currentPeriodStart` | Start date |
| 6 | `tenantSubscriptions.currentPeriodEnd` | End date |
| 7 | `+255775699545` | ALFEAN ENTERPRISES support WhatsApp number |

Footer: `Asante kwa kuchagua ALFEAN ENTERPRISES- POS kusimamia biashara yako`

### 2. `trial_ending_soon` — UTILITY, Swahili
Sent when a free trial has **5 days remaining**.

```
Habari {{1}}, muda wako wa majaribio (free trial) wa ALFEAN ENTERPRISES unaisha baada ya siku {{2}}.
Lipia ili kuweza kuendelea kutumia huduma ya ALFEAN ENTERPRISES-POS mfumo wa usimamizi wa biashara yako.
```

| # | Placeholder | Value |
|---|-------------|-------|
| 1 | `tenants.name` | Tenant / shop owner name |
| 2 | `tenantSubscriptions.currentPeriodEnd` | Days remaining (5) |

Footer: `Asante kwa kuchagua ALFEAN ENTERPRISES`

### 3. `trial_expired` — UTILITY, English (US)
Sent when the free trial has just expired (within the last 3 days).

```
Habari {{1}}, muda wako wa majaribio(free trial) wa ALFEAN ENTERPRISES umeisha.
Fanya malipo sasa ili kuendelea kutumia mfumo wa ALFEAN ENTERPRISES
```

| # | Placeholder | Value |
|---|-------------|-------|
| 1 | `tenants.name` | Tenant / shop owner name |

Button: **Whatsapp Support Number** → `+255775699545`

### 4. `package_expired` — UTILITY, English (US)
Sent when a paid package has just expired (within the last 3 days).

```
Habari {{1}}, kifurushi chako cha {{2}} kwenye ALFEAN ENTERPRISES kimeisha.
Fanya malipo sasa ili kuendelea kutumia mfumo.
```

| # | Placeholder | Value |
|---|-------------|-------|
| 1 | `tenants.name` | Tenant / shop owner name |
| 2 | `subscriptionPlans.name` | Plan name (e.g. "3-Month Plan") |

## To Create 🚧

These send functions are already wired up in code but the templates below are **not yet
created in the dashboard**. No message goes out until each exists and is APPROVED.

### 5. `package_expiring_soon` — UTILITY, Swahili
Sent when a paid package has **7 days remaining**.

```
Habari {{1}}, kifurushi chako cha {{2}} kinamalizika baada ya siku {{3}}.
Fanya malipo ili kuendelea kutumia ALFEAN ENTERPRISES-POS bila kukatizwa.
```

| # | Placeholder | Value |
|---|-------------|-------|
| 1 | `tenants.name` | Tenant / shop owner name |
| 2 | `subscriptionPlans.name` | Plan name |
| 3 | — | Days remaining (7) |

### 6. `payment_failed` — UTILITY, English (US)
Sent when a Snippe payment fails, reminding the user to retry.

```
Habari {{1}}, malipo yako ya kifurushi cha {{2}} (TZS {{3}}) hayakufaulu.
Jaribu tena kupitia: {{4}}
```

| # | Placeholder | Value |
|---|-------------|-------|
| 1 | `tenants.name` | Tenant / shop owner name |
| 2 | `subscriptionPlans.name` | Plan name |
| 3 | — | Amount (e.g. 150,000) |
| 4 | — | Retry URL (e.g. http://127.0.0.1:47831/subscription) |

### 7. `sale_receipt` — UTILITY, Swahili
Sent to a customer after a POS sale when a phone number was captured.

```
Habari {{1}}, asante kwa kununua kwenye {{2}}. Jumla: TZS {{3}} ({{4}}).
Risiti namba {{5}}. Karibu tena!
```

| # | Placeholder | Value |
|---|-------------|-------|
| 1 | — | Customer name |
| 2 | — | Shop name |
| 3 | — | Total amount |
| 4 | — | Payment method (cash / lipa_namba / bank / debt) |
| 5 | — | Receipt number (short sale id) |

### 8. `sms_balance_low` — UTILITY, English (US)
Sent daily to the owner while SMS credits are ≤ 5 (and > 0).

```
Habari {{1}}, salio lako la SMS limebaki {{2}} tu. Nunua SMS zaidi kupitia Sms Center ili kuendelea.
```

| # | Placeholder | Value |
|---|-------------|-------|
| 1 | `tenants.name` | Tenant / shop owner name |
| 2 | — | Remaining SMS credits |

### 9. `sms_balance_exhausted` — UTILITY, English (US)
Sent once to the owner when SMS credits reach 0.

```
Habari {{1}}, salio lako la SMS limeisha. Nunua SMS kupitia Sms Center ili kuendelea kuwafikia wateja wako.
```

| # | Placeholder | Value |
|---|-------------|-------|
| 1 | `tenants.name` | Tenant / shop owner name |

### 10. `promo_offer` — MARKETING, Swahili
Promotions, offers, and new-feature announcements. **MARKETING category requires explicit
opt-in** (tenants.marketing_opt_in = true) and must include an opt-out line.

```
Habari {{1}}, {{2}} — ALFEAN ENTERPRISES

Endesha mfumo wako bila malipo. Unakaribishwa kutembelea 127.0.0.1:47831 kwa maelezo zaidi.
*Unaweza kuacha kupokea matangazo kwa kujibu 'STOP'.*
```

| # | Placeholder | Value |
|---|-------------|-------|
| 1 | `tenants.name` | Tenant / shop owner name |
| 2 | — | Offer / feature text |

## Notes

- **Language codes are critical.** `trial_ending_soon` + `order_confirmation` are `sw`;
  `trial_expired` + `package_expired` are `en_US`. If a template is resubmitted under a
  different language, update `TEMPLATE_CONFIG` in `ghala-notifications.ts` to match.
- **Category on the dashboard:** `order_confirmation` is `utility`; `trial_ending_soon`,
  `trial_expired` and `package_expired` are currently `marketing` (as shown in the Ghala
  dashboard). Category does not block a send once the template is APPROVED.
- **Placeholder order is fixed.** Renumber or rename them with care — the code fills them
  in array order, so the sample values you submit should read like a real message.
- Every send is deduped against the `ghala_notification_log` table, so cron jobs
  (daily 14:00) never double-send the same reminder.
