import { Hono } from 'hono';
import { pool } from '../../config/drizzle.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';

const aiRoutes = new Hono<{
  Variables: {
    userId: string;
    userRole: string;
    tenantId: string;
    shopIds: string[];
  }
}>();

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const TZ = 'Africa/Dar_es_Salaam';

function resolveShopId(c: any, body: any): string | null {
  const shopIds = (c.get('shopIds') as string[]) || [];
  const requested = body?.shopId;
  if (requested && shopIds.includes(requested)) return requested;
  return shopIds[0] || null;
}

async function callDeepSeek(opts: {
  system: string;
  prompt: string;
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
}): Promise<any> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;

  const payload: any = {
    // deepseek-chat returns message.content reliably; some reasoning models on
    // the same endpoint return an empty content field.
    model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.prompt },
    ],
    max_tokens: opts.maxTokens || 700,
    temperature: opts.temperature ?? 0.6,
  };
  if (opts.json) payload.response_format = { type: 'json_object' };

  const response = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(payload),
  });
  if (!response.ok) return null;
  const data: any = await response.json();
  return data.choices?.[0]?.message?.content || null;
}

function safeJson(content: string | null): any {
  if (!content) return null;
  try { return JSON.parse(content); } catch { return null; }
}

// ─── 1. AI UPSELL / CROSS-SELL ───────────────────────────────────────────────
// Basket analysis: "customers who bought X also bought Y"
aiRoutes.post('/cross-sell', authMiddleware, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const shopId = resolveShopId(c, body);
    if (!shopId) return c.json({ success: false, error: 'No shop assigned' }, 400);

    const cartProductIds: string[] = Array.isArray(body.productIds) ? body.productIds : [];
    const limit = Math.min(Math.max(Number(body.limit) || 8, 1), 15);

    // Co-occurrence analysis over last 90 days
    const result = await pool.query(
      `SELECT si2.product_id, MAX(si2.product_name) as product_name,
              COUNT(DISTINCT si1.sale_id) as times_together,
              COALESCE(SUM(si2.quantity), 0) as qty_sold,
              MAX(p.selling_price) as selling_price,
              MAX(p.current_stock) as current_stock
       FROM sale_items si1
       JOIN sales s1 ON si1.sale_id = s1.id AND s1.shop_id = $1
       JOIN sale_items si2 ON si1.sale_id = si2.sale_id AND si1.product_id <> si2.product_id
       LEFT JOIN products p ON p.id = si2.product_id
       WHERE s1.created_at >= NOW() - INTERVAL '90 days'
         AND ($2::uuid[] IS NULL OR si1.product_id = ANY($2::uuid[]))
       GROUP BY si2.product_id
       ORDER BY times_together DESC, qty_sold DESC
       LIMIT $3`,
      [shopId, cartProductIds.length ? cartProductIds : null, limit]
    );

    const suggestions = result.rows
      .filter((r: any) => !cartProductIds.includes(r.product_id))
      .map((r: any) => ({
        productId: r.product_id,
        name: r.product_name,
        timesTogether: parseInt(r.times_together),
        qtySold: parseFloat(r.qty_sold),
        sellingPrice: parseFloat(r.selling_price || 0),
        stock: parseFloat(r.current_stock || 0),
      }));

    return c.json({ success: true, data: { suggestions } });
  } catch (e: any) {
    console.error('[AI Cross-sell] Error:', e.message);
    return c.json({ success: false, error: e.message }, 500);
  }
});

// ─── 2. SALES FORECAST (next 7 days) ────────────────────────────────────────
aiRoutes.post('/forecast', authMiddleware, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const shopId = resolveShopId(c, body);
    if (!shopId) return c.json({ success: false, error: 'No shop assigned' }, 400);

    const horizon = Math.min(Math.max(Number(body.days) || 7, 1), 30);

    // Daily revenue for last 60 days (best data, no AI needed for math)
    const daily = await pool.query(
      `SELECT to_char(created_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD') as day,
              COUNT(*) as orders,
              COALESCE(SUM(total_amount), 0) as revenue
       FROM sales
       WHERE shop_id = $1 AND created_at >= NOW() - INTERVAL '60 days'
       GROUP BY day ORDER BY day`,
      [shopId]
    );

    const rows = daily.rows;
    if (rows.length === 0) {
      return c.json({
        success: true,
        data: {
          forecast: [], totalForecast: 0, trend: 'flat', confidence: 0,
          insight: 'No sales history yet — start selling and ALFEAN ENTERPRISES will forecast for you.',
          aiInsight: null,
        },
      });
    }

    // Build per-weekday average and overall recent trend
    const weekdaySums: Record<number, { sum: number; count: number }> = {};
    for (const r of rows) {
      const d = new Date(r.day + 'T00:00:00Z');
      const dow = d.getUTCDay();
      weekdaySums[dow] = weekdaySums[dow] || { sum: 0, count: 0 };
      weekdaySums[dow].sum += parseFloat(r.revenue);
      weekdaySums[dow].count++;
    }

    // Linear trend via simple slope on last 30 days
    const last30 = rows.slice(-30);
    const n = last30.length;
    let trend = 'flat';
    if (n >= 7) {
      const firstHalf = last30.slice(0, Math.floor(n / 2)).reduce((s, r) => s + parseFloat(r.revenue), 0) / Math.floor(n / 2);
      const secondHalf = last30.slice(Math.floor(n / 2)).reduce((s, r) => s + parseFloat(r.revenue), 0) / (n - Math.floor(n / 2));
      trend = secondHalf > firstHalf * 1.1 ? 'up' : secondHalf < firstHalf * 0.9 ? 'down' : 'flat';
    }

    const forecast: any[] = [];
    let totalForecast = 0;
    for (let i = 1; i <= horizon; i++) {
      const d = new Date();
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() + i);
      const dow = d.getUTCDay();
      const ws = weekdaySums[dow];
      const projected = ws ? ws.sum / ws.count : 0;
      const recentAvg = rows.slice(-7).reduce((s, r) => s + parseFloat(r.revenue), 0) / Math.min(7, rows.length);
      const blended = projected * 0.7 + recentAvg * 0.3;
      const rounded = Math.round(blended);
      totalForecast += rounded;
      forecast.push({ date: d.toISOString().slice(0, 10), weekday: dow, projected: rounded });
    }

    const avgDaily = rows.reduce((s, r) => s + parseFloat(r.revenue), 0) / rows.length;
    const confidence = Math.min(95, Math.round(rows.length / 60 * 100));

    // AI narrative (optional)
    let aiInsight: string | null = null;
    const aiRaw = await callDeepSeek({
      json: true,
      system: 'You are ALFEAN ENTERPRISES Business Intelligence for Tanzania hardware stores. Return ONLY JSON: {"insight":"Swahili/English mix, under 70 words, plain-language business advice about the week ahead."}',
      prompt: `Shop sales last 60 days (revenue per day):\n${rows.slice(-14).map((r: any) => `${r.day}: TZS ${Number(r.revenue).toLocaleString()}`).join('\n')}\n\nTrend: ${trend}. Projected next ${horizon} days: TZS ${totalForecast.toLocaleString()}.`,
    });
    aiInsight = safeJson(aiRaw)?.insight || null;

    return c.json({
      success: true,
      data: {
        forecast,
        totalForecast,
        avgDaily: Math.round(avgDaily),
        trend,
        confidence,
        aiInsight,
      },
    });
  } catch (e: any) {
    console.error('[AI Forecast] Error:', e.message);
    return c.json({ success: false, error: e.message }, 500);
  }
});

// ─── 3. AI PRODUCT DESCRIPTIONS ─────────────────────────────────────────────
aiRoutes.post('/product-description', authMiddleware, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const shopId = resolveShopId(c, body);
    if (!shopId) return c.json({ success: false, error: 'No shop assigned' }, 400);

    let product: any = null;
    if (body.productId) {
      const res = await pool.query(
        `SELECT p.id, p.name, p.sku, p.buying_price, p.selling_price, p.unit_type, p.current_stock,
                COALESCE(c.name, 'General') as category
         FROM products p LEFT JOIN categories c ON c.id = p.category_id
         WHERE p.id = $1 AND p.shop_id = $2`,
        [body.productId, shopId]
      );
      product = res.rows[0] || null;
    }

    const name = body.name || product?.name;
    if (!name) return c.json({ success: false, error: 'Product name required' }, 400);

    const context = {
      name,
      category: body.category || product?.category || 'General',
      sku: body.sku || product?.sku || null,
      unitType: body.unitType || product?.unit_type || 'PCS',
      sellingPrice: body.sellingPrice || product?.selling_price || null,
    };

    // Fallback description (works without API key)
    const fallback = `${context.name} — ${context.category.toLowerCase()} ya ubora. ${context.sellingPrice ? `Bei: TZS ${Number(context.sellingPrice).toLocaleString()}.` : ''}`;

    const aiRaw = await callDeepSeek({
      json: true,
      system: 'You are a product copywriter for Tanzanian hardware/general store products sold through ALFEAN ENTERPRISES POS. Write in English, professional and concise. Return ONLY JSON: {"description":"1-2 sentences under 40 words"}',
      prompt: `Write a short product description for: ${JSON.stringify(context)}`,
      maxTokens: 150,
    });
    const parsed = safeJson(aiRaw);
    const description = parsed?.description || fallback;

    return c.json({ success: true, data: { description } });
  } catch (e: any) {
    console.error('[AI Product Description] Error:', e.message);
    return c.json({ success: false, error: e.message }, 500);
  }
});

// ─── 4. CUSTOMER CREDIT SCORE ───────────────────────────────────────────────
aiRoutes.post('/credit-score', authMiddleware, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const shopId = resolveShopId(c, body);
    if (!shopId) return c.json({ success: false, error: 'No shop assigned' }, 400);

    const limit = Math.min(Math.max(Number(body.limit) || 20, 1), 100);

    // Combine customers table + sales stats + debt history
    const result = await pool.query(
      `SELECT
         COALESCE(c.id::text, 'anon:' || s.customer_name) as customer_key,
         COALESCE(c.name, s.customer_name, 'Unknown') as customer_name,
         COALESCE(c.phone, s.customer_phone, '') as phone,
         COALESCE(c.total_visits, 0) as total_visits,
         COALESCE(c.total_spent, 0) as total_spent,
         c.last_purchase_at,
         c.return_count,
         COUNT(s.id) as sale_count,
         COALESCE(SUM(CASE WHEN s.amount_paid < s.total_amount THEN 1 ELSE 0 END), 0) as debt_sale_count,
         COALESCE(SUM(s.total_amount - s.amount_paid), 0) as outstanding,
         MAX(CASE WHEN s.due_date < CURRENT_DATE AND s.amount_paid < s.total_amount THEN 1 ELSE 0 END)::int as overdue_flag
       FROM sales s
       LEFT JOIN customers c ON LOWER(COALESCE(c.name,'')) = LOWER(COALESCE(s.customer_name,'')) OR (c.phone = s.customer_phone AND c.phone IS NOT NULL AND s.customer_phone IS NOT NULL)
       WHERE s.shop_id = $1 AND s.customer_name IS NOT NULL AND s.customer_name <> ''
       GROUP BY c.id, c.name, c.phone, c.total_visits, c.total_spent, c.last_purchase_at, c.return_count, s.customer_name, s.customer_phone
       ORDER BY outstanding DESC, sale_count DESC
       LIMIT $2`,
      [shopId, limit * 3]
    );

    const now = Date.now();
    const scored = result.rows.map((r: any) => {
      let score = 50;
      const visits = parseInt(r.total_visits) || 0;
      const spent = parseFloat(r.total_spent) || 0;
      const outstanding = parseFloat(r.outstanding) || 0;
      const saleCount = parseInt(r.sale_count) || 0;
      const overdue = parseInt(r.overdue_flag) || 0;
      const returns = parseInt(r.return_count) || 0;

      if (visits >= 20) score += 15;
      else if (visits >= 10) score += 10;
      else if (visits >= 3) score += 5;

      if (spent >= 2000000) score += 15;
      else if (spent >= 500000) score += 10;
      else if (spent >= 100000) score += 5;

      if (saleCount >= 10) score += 10;
      else if (saleCount >= 5) score += 5;

      if (r.last_purchase_at) {
        const daysAgo = (now - new Date(r.last_purchase_at).getTime()) / 86400000;
        if (daysAgo < 7) score += 10;
        else if (daysAgo < 30) score += 5;
      }

      score -= Math.min(30, Math.floor(outstanding / 500000) * 5);
      if (overdue) score -= 15;
      score -= Math.min(10, returns * 3);

      score = Math.max(0, Math.min(100, score));
      const tier = score >= 80 ? 'Excellent' : score >= 60 ? 'Good' : score >= 40 ? 'Fair' : 'Risky';
      return {
        customerId: r.customer_key,
        name: r.customer_name,
        phone: r.phone,
        score,
        tier,
        totalSpent: spent,
        saleCount,
        outstanding,
        overdue: overdue === 1,
        lastPurchaseAt: r.last_purchase_at,
      };
    });

    scored.sort((a: any, b: any) => b.score - a.score);
    const top = scored.slice(0, limit);

    return c.json({
      success: true,
      data: {
        customers: top,
        summary: {
          totalCustomers: scored.length,
          excellent: scored.filter((x: any) => x.tier === 'Excellent').length,
          good: scored.filter((x: any) => x.tier === 'Good').length,
          fair: scored.filter((x: any) => x.tier === 'Fair').length,
          risky: scored.filter((x: any) => x.tier === 'Risky').length,
          totalOutstanding: scored.reduce((s: number, x: any) => s + x.outstanding, 0),
        },
      },
    });
  } catch (e: any) {
    console.error('[AI Credit Score] Error:', e.message);
    return c.json({ success: false, error: e.message }, 500);
  }
});

// ─── 5. SMART REORDER LIST ──────────────────────────────────────────────────
aiRoutes.post('/reorder', authMiddleware, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const shopId = resolveShopId(c, body);
    if (!shopId) return c.json({ success: false, error: 'No shop assigned' }, 400);

    const leadDays = Math.min(Math.max(Number(body.leadDays) || 7, 1), 30);
    const safetyDays = Math.min(Math.max(Number(body.safetyDays) || 3, 0), 14);

    // 30-day sales velocity per product
    const velocity = await pool.query(
      `SELECT si.product_id,
              MAX(p.name) as name,
              MAX(p.sku) as sku,
              MAX(p.current_stock) as stock,
              MAX(p.low_stock_threshold) as low_stock_threshold,
              MAX(p.buying_price) as buying_price,
              COALESCE(SUM(si.quantity), 0) as qty_sold
       FROM sale_items si
       JOIN sales s ON si.sale_id = s.id
       JOIN products p ON p.id = si.product_id
       WHERE s.shop_id = $1 AND p.is_active = true AND s.created_at >= NOW() - INTERVAL '30 days'
       GROUP BY si.product_id`,
      [shopId]
    );

    const items = velocity.rows.map((r: any) => {
      const dailyRate = parseFloat(r.qty_sold) / 30;
      const stock = parseFloat(r.stock || 0);
      const threshold = parseFloat(r.low_stock_threshold || 10);
      const daysOfStock = dailyRate > 0 ? stock / dailyRate : stock >= threshold ? Infinity : 0;

      const reorderPoint = dailyRate * (leadDays + safetyDays);
      const suggestedOrder = Math.max(0, Math.ceil(reorderPoint - stock));
      const lowStock = stock <= threshold;

      let priority: 'critical' | 'high' | 'medium' | 'ok' = 'ok';
      if (daysOfStock <= leadDays && dailyRate > 0) priority = 'critical';
      else if (lowStock && dailyRate > 0) priority = 'high';
      else if (lowStock) priority = 'medium';

      return {
        productId: r.product_id,
        name: r.name,
        sku: r.sku || null,
        currentStock: stock,
        dailyRate: Math.round(dailyRate * 100) / 100,
        daysOfStock: isFinite(daysOfStock) ? Math.round(daysOfStock * 10) / 10 : null,
        suggestedOrder,
        lowStockThreshold: threshold,
        priority,
        buyingPrice: parseFloat(r.buying_price || 0),
      };
    });

    const actionable = items
      .filter((i: any) => i.suggestedOrder > 0 || i.priority !== 'ok')
      .sort((a: any, b: any) => {
        const order = { critical: 0, high: 1, medium: 2, ok: 3 } as any;
        return (order[a.priority] - order[b.priority]) || (b.suggestedOrder - a.suggestedOrder);
      });

    const totalCost = actionable.reduce((s: number, i: any) => s + (i.suggestedOrder * i.buyingPrice), 0);

    return c.json({
      success: true,
      data: {
        items: actionable.slice(0, 100),
        summary: {
          critical: actionable.filter((i: any) => i.priority === 'critical').length,
          high: actionable.filter((i: any) => i.priority === 'high').length,
          medium: actionable.filter((i: any) => i.priority === 'medium').length,
          totalItems: actionable.length,
          estimatedCost: Math.round(totalCost),
        },
      },
    });
  } catch (e: any) {
    console.error('[AI Reorder] Error:', e.message);
    return c.json({ success: false, error: e.message }, 500);
  }
});

// ─── 6. AI BUSINESS COACH ───────────────────────────────────────────────────
aiRoutes.post('/coach', authMiddleware, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const shopId = resolveShopId(c, body);
    if (!shopId) return c.json({ success: false, error: 'No shop assigned' }, 400);
    const question = String(body.question || '').trim();

    const [shopRes, statsRes, catRes, topRes, lossRes, lowRes, debtRes, expRes, trendRes] = await Promise.all([
      pool.query('SELECT name FROM shops WHERE id = $1', [shopId]),
      pool.query(
        `SELECT
          (SELECT COALESCE(SUM(total_amount),0) FROM sales WHERE shop_id=$1) as lifetime,
          (SELECT COALESCE(SUM(total_amount),0) FROM sales WHERE shop_id=$1 AND created_at >= CURRENT_DATE - INTERVAL '30 days') as revenue_30d,
          (SELECT COALESCE(SUM(si.profit),0) FROM sale_items si JOIN sales s ON si.sale_id=s.id WHERE s.shop_id=$1 AND s.created_at >= CURRENT_DATE - INTERVAL '30 days') as profit_30d,
          (SELECT COUNT(*) FROM products WHERE shop_id=$1 AND is_active=true) as products,
          (SELECT COALESCE(SUM(current_stock*buying_price),0) FROM products WHERE shop_id=$1 AND is_active=true) as stock_value`,
        [shopId]
      ),
      pool.query(
        `SELECT category, COUNT(*) as n, COALESCE(SUM(amount),0) as total FROM expenses WHERE shop_id=$1 AND date >= CURRENT_DATE - INTERVAL '30 days' GROUP BY category ORDER BY total DESC LIMIT 5`,
        [shopId]
      ),
      pool.query(
        `SELECT si.product_name, SUM(si.quantity) as qty, COALESCE(SUM(si.profit),0) as profit
         FROM sale_items si JOIN sales s ON si.sale_id=s.id
         WHERE s.shop_id=$1 AND s.created_at >= CURRENT_DATE - INTERVAL '30 days'
         GROUP BY si.product_name ORDER BY profit DESC LIMIT 5`,
        [shopId]
      ),
      pool.query(
        `SELECT id, name, selling_price, buying_price FROM products WHERE shop_id=$1 AND is_active=true AND selling_price < buying_price LIMIT 5`,
        [shopId]
      ),
      pool.query(
        `SELECT name, current_stock FROM products WHERE shop_id=$1 AND is_active=true AND current_stock <= COALESCE(low_stock_threshold,10) ORDER BY current_stock ASC LIMIT 5`,
        [shopId]
      ),
      pool.query(
        `SELECT COUNT(*) as n, COALESCE(SUM(total_amount-paid_amount),0) as remaining FROM debtors WHERE shop_id=$1 AND status IN ('unpaid','partial')`,
        [shopId]
      ),
      pool.query(
        `SELECT COUNT(*) as n, COALESCE(SUM(amount),0) as total FROM expenses WHERE shop_id=$1 AND date >= CURRENT_DATE - INTERVAL '30 days'`,
        [shopId]
      ),
      pool.query(
        `SELECT to_char(created_at AT TIME ZONE '${TZ}','YYYY-MM-DD') as day, COALESCE(SUM(total_amount),0) as revenue
         FROM sales WHERE shop_id=$1 AND created_at >= CURRENT_DATE - INTERVAL '14 days' GROUP BY day ORDER BY day`,
        [shopId]
      ),
    ]);

    const shop = shopRes.rows[0];
    const s = statsRes.rows[0];
    const revenue30 = parseFloat(s.revenue_30d);
    const profit30 = parseFloat(s.profit_30d);
    const exp30 = parseFloat(expRes.rows[0]?.total || 0);
    const margin = revenue30 > 0 ? Math.round((profit30 / revenue30) * 1000) / 10 : 0;

    const trendLine = trendRes.rows.map((r: any) => `${r.day}: TZS ${Number(r.revenue).toLocaleString()}`).join('\n');

    const context = `Shop: ${shop?.name}
Last 30 days: Revenue TZS ${revenue30.toLocaleString()} | Profit TZS ${profit30.toLocaleString()} (${margin}% margin) | Expenses TZS ${exp30.toLocaleString()}
Lifetime revenue: TZS ${parseFloat(s.lifetime).toLocaleString()} | Stock value: TZS ${parseFloat(s.stock_value).toLocaleString()} | Products: ${s.products}
Top profit products: ${topRes.rows.length ? topRes.rows.map((r: any) => `${r.product_name} (${r.qty} sold, profit ${Number(r.profit).toLocaleString()})`).join(', ') : 'none yet'}
Loss-making products (selling below cost): ${lossRes.rows.length ? lossRes.rows.map((r: any) => r.name).join(', ') : 'none'}
Low stock: ${lowRes.rows.length ? lowRes.rows.map((r: any) => `${r.name} (${r.current_stock})`).join(', ') : 'none'}
Debtors: ${debtRes.rows[0]?.n || 0} active, TZS ${Number(debtRes.rows[0]?.remaining || 0).toLocaleString()} remaining
Top expense categories: ${catRes.rows.length ? catRes.rows.map((r: any) => `${r.category} (TZS ${Number(r.total).toLocaleString()})`).join(', ') : 'none'}
Revenue last 14 days:\n${trendLine}`;

    const prompt = question
      ? `The business owner asks: "${question}"\n\nUse this real data to answer with practical, specific advice:\n${context}`
      : `Analyze this hardware business and give 3 actionable recommendations with expected impact. Use the real numbers.\n${context}`;

    const system = `You are ALFEAN ENTERPRISES Business Coach for Tanzanian small businesses (hardware stores, shops). Speak Swahili mixed with English. Answer ONLY with real numbers from the data. Be practical and specific. ${question ? 'Answer the question directly.' : 'Return a focused analysis, no fluff.'} Keep under 180 words.`;

    const answer = await callDeepSeek({ system, prompt, maxTokens: 900, temperature: 0.6 });
    if (!answer) {
      return c.json({
        success: true,
        data: {
          answer: `Coach requires DEEPSEEK_API_KEY. Meanwhile: 30-day revenue TZS ${revenue30.toLocaleString()}, profit TZS ${profit30.toLocaleString()} (${margin}% margin), expenses TZS ${exp30.toLocaleString()}, ${lowRes.rows.length} low-stock products.`,
        },
      });
    }

    return c.json({ success: true, data: { answer, context: { revenue30, profit30, margin, exp30 } } });
  } catch (e: any) {
    console.error('[AI Coach] Error:', e.message);
    return c.json({ success: false, error: e.message }, 500);
  }
});

// ─── 7. AI ANOMALY NARRATOR ─────────────────────────────────────────────────
aiRoutes.post('/anomaly-narrator', authMiddleware, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const anomalies = Array.isArray(body.anomalies) ? body.anomalies.slice(0, 20) : [];
    if (anomalies.length === 0) {
      return c.json({ success: true, data: { narratives: [], summary: 'No anomalies to explain.' } });
    }

    const summary = await callDeepSeek({
      json: true,
      system: 'You are a fraud/anomaly explainer for a Tanzanian POS system (ALFEAN ENTERPRISES). Given flagged anomalies, explain each in plain Swahili with a recommended action. Return ONLY JSON: {"narratives":[{"type":"...","explanation":"Swahili, under 40 words","action":"specific next step"}],"summary":"one-line overall assessment in Swahili"}',
      prompt: `Explain these flagged anomalies:\n${anomalies.map((a: any) => `- [${a.severity}] ${a.type}: ${a.message} (${a.details || ''})`).join('\n')}`,
    });

    const parsed = safeJson(summary);
    if (parsed?.narratives) {
      return c.json({ success: true, data: parsed });
    }

    // Fallback: deterministic plain-text explanation per type
    const typeExplanations: Record<string, string> = {
      after_hours_sale: 'Mauzo yamefanyika usiku (saa 10pm-6am). Angalia kama ni mteja maalum au opereta anayeuza bila idhini.',
      high_discount: 'Punguzo kubwa limewekwa. Hii inaweza kuashiria uuzaji wa bei ndogo kuliko kawaida (theft). Thibitisha na cashier.',
      large_adjustment: 'Marekebisho makubwa ya stock yametokea. Hakikisha hayajasababisha hasara ya bidhaa.',
      inactive_seller: 'Muuzaji hajaingia mfumo kwa muda mrefu. Angalia kama bado anafanya kazi.',
    };
    const narratives = anomalies.map((a: any) => ({
      type: a.type,
      explanation: typeExplanations[a.type] || `${a.message} — thibitisha ukweli wa tukio hili.`,
      action: a.severity === 'high' ? 'Chukua hatua mara moja na uandike taarifa.' : 'Angalia na ufuatilie.',
    }));

    return c.json({ success: true, data: { narratives, summary: `${narratives.length} anomaly zimechambuliwa.` } });
  } catch (e: any) {
    console.error('[AI Anomaly Narrator] Error:', e.message);
    return c.json({ success: false, error: e.message }, 500);
  }
});

// ─── 8. BUSINESS BENCHMARKING ───────────────────────────────────────────────
aiRoutes.post('/benchmark', authMiddleware, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const shopId = resolveShopId(c, body);
    if (!shopId) return c.json({ success: false, error: 'No shop assigned' }, 400);

    // This shop's metrics (30 days)
    const shopRes = await pool.query(
      `SELECT
        (SELECT COALESCE(SUM(total_amount),0) FROM sales WHERE shop_id=$1 AND created_at >= CURRENT_DATE - INTERVAL '30 days') as revenue,
        (SELECT COALESCE(SUM(si.profit),0) FROM sale_items si JOIN sales s ON si.sale_id=s.id WHERE s.shop_id=$1 AND s.created_at >= CURRENT_DATE - INTERVAL '30 days') as profit,
        (SELECT COALESCE(SUM(amount),0) FROM expenses WHERE shop_id=$1 AND date >= CURRENT_DATE - INTERVAL '30 days') as expenses,
        (SELECT COUNT(DISTINCT sale_id) FROM sale_items si JOIN sales s ON si.sale_id=s.id WHERE s.shop_id=$1 AND s.created_at >= CURRENT_DATE - INTERVAL '30 days') as orders`,
      [shopId]
    );

    const mine = shopRes.rows[0];
    const revenue = parseFloat(mine.revenue);
    const profit = parseFloat(mine.profit);
    const expenses = parseFloat(mine.expenses);
    const orders = parseInt(mine.orders);
    const myMargin = revenue > 0 ? profit / revenue : 0;

    // Anonymous aggregate across all non-super-admin shops (last 30 days)
    const peers = await pool.query(
      `WITH shopstats AS (
         SELECT s.shop_id,
                COALESCE(SUM(s.total_amount),0) as revenue,
                COALESCE(SUM(si.profit),0) as profit,
                COUNT(s.id) as orders
         FROM sales s
         LEFT JOIN sale_items si ON si.sale_id = s.id
         WHERE s.created_at >= CURRENT_DATE - INTERVAL '30 days'
         GROUP BY s.shop_id
       )
       SELECT shop_id, revenue, profit, orders,
              CASE WHEN revenue > 0 THEN profit / revenue ELSE 0 END as margin
       FROM shopstats`
    );

    const peerRows = peers.rows
      .filter((r: any) => r.shop_id !== shopId && parseFloat(r.revenue) > 0)
      .map((r: any) => ({ margin: parseFloat(r.margin), revenue: parseFloat(r.revenue), orders: parseInt(r.orders) }));

    const peerCount = peerRows.length;
    const avgPeerMargin = peerCount > 0 ? peerRows.reduce((s, r) => s + r.margin, 0) / peerCount : 0;
    const betterThan = peerCount > 0
      ? Math.round(peerRows.filter((r: any) => r.margin <= myMargin).length / peerCount * 100)
      : 0;
    const avgPeerRevenue = peerCount > 0 ? peerRows.reduce((s, r) => s + r.revenue, 0) / peerCount : 0;
    const avgPeerOrders = peerCount > 0 ? Math.round(peerRows.reduce((s, r) => s + r.orders, 0) / peerCount) : 0;

    let narrative: string | null = null;
    const aiRaw = await callDeepSeek({
      json: true,
      system: 'You are a benchmarking analyst for ALFEAN ENTERPRISES Tanzania. Return ONLY JSON: {"narrative":"Swahili/English mix, under 80 words, friendly comparison with the percentile and the main gap to close."}',
      prompt: `Shop margin ${(myMargin * 100).toFixed(1)}%, avg peer margin ${(avgPeerMargin * 100).toFixed(1)}%. Shop beats ${betterThan}% of ${peerCount} similar shops on margin. Shop 30d revenue TZS ${revenue.toLocaleString()} vs peer avg TZS ${Math.round(avgPeerRevenue).toLocaleString()}.`,
    });
    narrative = safeJson(aiRaw)?.narrative || null;

    return c.json({
      success: true,
      data: {
        mine: { revenue, profit, expenses, orders, marginPct: Math.round(myMargin * 1000) / 10 },
        peers: {
          count: peerCount,
          avgMarginPct: Math.round(avgPeerMargin * 1000) / 10,
          avgRevenue: Math.round(avgPeerRevenue),
          avgOrders: avgPeerOrders,
        },
        percentile: betterThan,
        narrative,
      },
    });
  } catch (e: any) {
    console.error('[AI Benchmark] Error:', e.message);
    return c.json({ success: false, error: e.message }, 500);
  }
});

export default aiRoutes;
