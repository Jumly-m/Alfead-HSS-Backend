import crypto from 'node:crypto';

const SNIPPE_BASE = 'https://api.snippe.sh';

function getApiKey(): string {
  const key = process.env.SNIPPE_API_KEY;
  if (!key) throw new Error('SNIPPE_API_KEY environment variable is not set');
  return key;
}

function getWebhookSecret(): string {
  const secret = process.env.SNIPPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('SNIPPE_WEBHOOK_SECRET environment variable is not set');
  return secret;
}

function getAppUrl(): string {
  const url = process.env.APP_URL;
  if (!url) throw new Error('APP_URL environment variable is not set');
  return url;
}

export type PaymentType = 'mobile' | 'card' | 'dynamic_qr';

export interface InitiatePaymentParams {
  amountTzs: number;
  phone: string;
  firstName: string;
  lastName: string;
  email: string;
  idempotencyKey: string;
  paymentType?: PaymentType;
  redirectUrl?: string;
  cancelUrl?: string;
  address?: string;
  city?: string;
  state?: string;
  postcode?: string;
  country?: string;
  metadata?: Record<string, string>;
}

export interface SnippePaymentResponse {
  reference: string;
  status: string;
  expiresAt: string;
  paymentUrl?: string;
  paymentQr?: string;
  paymentToken?: string;
}

export async function initiateSubscriptionPayment(
  params: InitiatePaymentParams
): Promise<SnippePaymentResponse> {
  const type = params.paymentType ?? 'mobile';
  const apiKey = getApiKey();
  const appUrl = getAppUrl();

  const details: Record<string, unknown> = {
    amount: params.amountTzs,
    currency: 'TZS',
  };

  if (type !== 'mobile') {
    details.redirect_url = params.redirectUrl ?? `${appUrl}/payment-success`;
    details.cancel_url = params.cancelUrl ?? `${appUrl}/payment-cancel`;
  }

  // Strip spaces/dashes users paste ("0712 345 678") BEFORE normalizing —
  // otherwise the digits-only check fails and the purchase dies with an
  // opaque "Invalid phone number format" error.
  const rawPhone = params.phone.replace(/[^\d+]/g, '');
  const phoneNumber = rawPhone.startsWith('+') || rawPhone.startsWith('255')
    ? rawPhone.replace('+', '')
    : `255${rawPhone.replace(/^0/, '')}`;

  // Ensure phone number is valid (10-13 digits)
  if (!/^\d{10,13}$/.test(phoneNumber)) {
    throw new Error(`Invalid phone number format: ${phoneNumber}. Expected 10-13 digits starting with 255.`);
  }

  // Customer is required for ALL payment types
  const customer: Record<string, string> = {
    firstname: params.firstName || 'Customer',
    lastname: params.lastName || 'User',
    email: params.email || 'customer@example.com',
  };

  if (type === 'card') {
    customer.address = params.address ?? '';
    customer.city = params.city ?? '';
    customer.state = params.state ?? 'DSM';
    customer.postcode = params.postcode ?? '00000';
    customer.country = params.country ?? 'TZ';
  }

  const body: Record<string, unknown> = {
    payment_type: type,
    details,
    phone_number: phoneNumber,
    webhook_url: `${appUrl}/api/webhooks/snippe`,
    customer,
    metadata: params.metadata ?? {},
  };

  const res = await fetch(`${SNIPPE_BASE}/v1/payments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'Idempotency-Key': params.idempotencyKey.slice(0, 30),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Snippe error: ${JSON.stringify(err)}`);
  }

  const json = await res.json() as any;
  const d = json.data;

  return {
    reference: d.reference,
    status: d.status,
    expiresAt: d.expires_at,
    paymentUrl: d.payment_url,
    paymentQr: d.payment_qr_code,
    paymentToken: d.payment_token,
  };
}

export function verifyWebhookSignature(
  rawBody: string,
  timestamp: string,
  signature: string
): boolean {
  const webhookSecret = getWebhookSecret();
  const eventTime = parseInt(timestamp, 10);
  const now = Math.floor(Date.now() / 1000);

  // Snippe signs retries with the ORIGINAL event timestamp and retries up to
  // ~24 min after the event. A strict 5-minute window rejected every retry
  // after the first failure → completed payments never reached us in real
  // time. 6h comfortably covers the whole retry schedule + clock skew; replay
  // is harmless because purchase completion is idempotent (atomic claim).
  if (isNaN(eventTime) || now - eventTime > 21600) return false;

  const message = `${timestamp}.${rawBody}`;
  const expected = crypto
    .createHmac('sha256', webhookSecret)
    .update(message)
    .digest('hex');

  try {
    const a = Buffer.from(signature, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Short-TTL cache + in-flight dedupe for payment status reads. The purchase
// flow hits Snippe status from three places at once (client 5s poll → reconcile
// + status endpoint, purchase-history load, background cron). Snippe rate-
// limits 60 req/min across ALL users; without this, two concurrent buyers
// exhaust the budget, every status call 429s, and purchases look stuck as
// "pending" even though the payment went through.
const statusCache = new Map<string, { data: any; expires: number }>();
const statusInflight = new Map<string, Promise<any>>();
const STATUS_TTL_MS = 5000;

export async function getPaymentStatus(reference: string) {
  const cached = statusCache.get(reference);
  if (cached && cached.expires > Date.now()) return cached.data;

  const inflight = statusInflight.get(reference);
  if (inflight) return inflight;

  const fetchPromise = (async () => {
    const apiKey = getApiKey();
    const res = await fetch(`${SNIPPE_BASE}/v1/payments/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`Snippe status error ${res.status}: ${JSON.stringify(body)}`);
    }
    const json = await res.json() as any;
    statusCache.set(reference, { data: json.data, expires: Date.now() + STATUS_TTL_MS });
    return json.data;
  })();

  statusInflight.set(reference, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    statusInflight.delete(reference);
  }
}

// Startup self-check: reports which payment-provider credentials are present
// (never their values). A missing SNIPPE_API_KEY means every purchase fails at
// initiation; a missing SNIPPE_WEBHOOK_SECRET means completions are rejected
// with 401 and payments stay pending forever.
export function logSnippeConfigStatus() {
  const missing = [
    !process.env.SNIPPE_API_KEY && 'SNIPPE_API_KEY',
    !process.env.SNIPPE_WEBHOOK_SECRET && 'SNIPPE_WEBHOOK_SECRET',
    !process.env.APP_URL && 'APP_URL',
  ].filter(Boolean);
  if (missing.length) {
    console.error(`[Snippe] ❌ Missing payment config: ${missing.join(', ')} — SMS/subscription purchases WILL fail`);
  } else {
    console.log('[Snippe] ✅ Payment provider auth configured (API key, webhook secret, APP_URL)');
  }
}

// Re-triggers the USSD push for a pending mobile payment. Use this when the
// customer never received the prompt (network hiccup on the provider side).
export async function triggerPaymentPush(reference: string) {
  const apiKey = getApiKey();
  const res = await fetch(`${SNIPPE_BASE}/v1/payments/${encodeURIComponent(reference)}/push`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `push-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.slice(0, 30),
    },
    body: JSON.stringify({}),
  });

  const json = await res.json().catch(() => ({})) as any;
  if (!res.ok) {
    throw new Error(`Snippe push error ${res.status}: ${JSON.stringify(json)}`);
  }
  return json.data ?? json;
}

// Fire-and-forget version used right after a payment is created. Snippe's
// automatic USSD push is not reliable — when it doesn't arrive, the payment
// silently expires ~10 minutes later and the customer sees nothing. Reusing
// the same Idempotency-Key would return a cached response WITHOUT sending, so
// every call gets a fresh key.
export async function ensurePaymentPush(reference: string): Promise<void> {
  try {
    await triggerPaymentPush(reference);
    console.log(`[Snippe] USSD push triggered for ${reference}`);
  } catch (e: any) {
    console.warn(`[Snippe] USSD push failed for ${reference}:`, e.message);
  }
}

export async function getAccountBalance() {
  const apiKey = getApiKey();
  try {
    const res = await fetch(`${SNIPPE_BASE}/v1/payments/balance`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!res.ok) {
      console.warn('[Snippe] Balance fetch failed:', res.status);
      return null;
    }
    return (await res.json() as any).data;
  } catch (e: any) {
    console.warn('[Snippe] Balance fetch error:', e.message);
    return null;
  }
}