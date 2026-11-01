import { Hono } from 'hono';
import { db } from '../../config/database.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';

const router = new Hono();

// The combined (multi-business) dashboard is an admin/owner tool only: it
// aggregates every shop the caller can access into one view. Sellers keep
// their normal single-shop dashboard untouched.
const isAdminRole = (role: string) => role === 'admin' || role === 'owner';

const eatRanges = () => {
  const now = new Date();
  const eatOffsetMs = 3 * 60 * 60 * 1000;
  const nowEAT = new Date(now.getTime() + eatOffsetMs);
  const dayStartUTC = new Date(Date.UTC(nowEAT.getUTCFullYear(), nowEAT.getUTCMonth(), nowEAT.getUTCDate()) - eatOffsetMs);
  const dayEndUTC = new Date(dayStartUTC.getTime() + 86400000);
  const monthStartUTC = new Date(Date.UTC(nowEAT.getUTCFullYear(), nowEAT.getUTCMonth(), 1) - eatOffsetMs);
  const monthStartStr = `${nowEAT.getUTCFullYear()}-${String(nowEAT.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const todayStr = nowEAT.toISOString().slice(0, 10);
  const trendStartUTC = new Date(dayStartUTC.getTime() - 13 * 86400000);
  return { now, dayStartUTC, dayEndUTC, monthStartUTC, monthStartStr, todayStr, trendStartUTC };
};

const num = (v: any) => parseFloat(v) || 0;

async function gatherOverview(shopIds: string[]) {
  const { dayStartUTC, dayEndUTC, monthStartUTC, monthStartStr, trendStartUTC } = eatRanges();

  const [shopsRes, perShopRes, trendRes, topProductsRes, sellersRes, recentSalesRes] = await Promise.all([
    db.read(
      `SELECT id, name, code, address, phone, email, logo, created_at
       FROM shops WHERE id = ANY($1) ORDER BY created_at ASC`,
      [shopIds]
    ),

    // Per-shop aggregates. Sales figures follow the same "money received"
    // definition as the single-shop /stats endpoint: cash-like sales + debt
    // payments + invoice payments + pre-order deposits.
    db.read(
      `SELECT s.id, s.name,
        (SELECT COUNT(*) FROM products p WHERE p.shop_id = s.id AND p.is_active = true) AS product_count,
        (SELECT COALESCE(SUM(p.current_stock * p.buying_price), 0) FROM products p WHERE p.shop_id = s.id AND p.is_active = true) AS stock_value,
        (SELECT COUNT(*) FROM products p WHERE p.shop_id = s.id AND p.is_active = true AND p.current_stock <= COALESCE(p.low_stock_threshold, 10)) AS low_stock_count,
        (SELECT COUNT(*) FROM sales sa WHERE sa.shop_id = s.id AND sa.created_at >= $2 AND sa.created_at < $3) AS today_orders,
        (
          (SELECT COALESCE(SUM(sa.total_amount), 0) FROM sales sa WHERE sa.shop_id = s.id AND sa.payment_method IN ('cash','lipa_namba','bank') AND sa.sale_type IS DISTINCT FROM 'pre_order' AND sa.created_at >= $2 AND sa.created_at < $3)
          + (SELECT COALESCE(SUM(dp.amount), 0) FROM debt_payments dp JOIN debtors dd ON dp.debtor_id = dd.id WHERE dd.shop_id = s.id AND dp.created_at >= $2 AND dp.created_at < $3)
          + (SELECT COALESCE(SUM(ip.amount), 0) FROM invoice_payments ip JOIN sales sa2 ON ip.sale_id = sa2.id WHERE sa2.shop_id = s.id AND ip.created_at >= $2 AND ip.created_at < $3)
          + (SELECT COALESCE(SUM(pp.amount), 0) FROM pre_order_payments pp JOIN pre_orders po ON pp.pre_order_id = po.id WHERE po.shop_id = s.id AND pp.created_at >= $2 AND pp.created_at < $3)
        ) AS today_sales,
        (
          (SELECT COALESCE(SUM(sa.total_amount), 0) FROM sales sa WHERE sa.shop_id = s.id AND sa.payment_method IN ('cash','lipa_namba','bank') AND sa.sale_type IS DISTINCT FROM 'pre_order' AND sa.created_at >= $4)
          + (SELECT COALESCE(SUM(dp.amount), 0) FROM debt_payments dp JOIN debtors dd ON dp.debtor_id = dd.id WHERE dd.shop_id = s.id AND dp.created_at >= $4)
          + (SELECT COALESCE(SUM(ip.amount), 0) FROM invoice_payments ip JOIN sales sa2 ON ip.sale_id = sa2.id WHERE sa2.shop_id = s.id AND ip.created_at >= $4)
          + (SELECT COALESCE(SUM(pp.amount), 0) FROM pre_order_payments pp JOIN pre_orders po ON pp.pre_order_id = po.id WHERE po.shop_id = s.id AND pp.created_at >= $4)
        ) AS month_sales,
        (SELECT COALESCE(SUM(si.profit), 0) FROM sale_items si JOIN sales sa ON si.sale_id = sa.id WHERE sa.shop_id = s.id AND sa.created_at >= $2 AND sa.created_at < $3) AS today_profit,
        (SELECT COALESCE(SUM(d.total_amount - COALESCE(d.paid_amount, 0)), 0) FROM debtors d WHERE d.shop_id = s.id AND COALESCE(d.status, 'unpaid') <> 'paid') AS unpaid_debt,
        (SELECT COUNT(*) FROM debtors d WHERE d.shop_id = s.id AND COALESCE(d.status, 'unpaid') <> 'paid') AS debtors_count,
        (SELECT COALESCE(SUM(e.amount), 0) FROM expenses e WHERE e.shop_id = s.id AND e.date >= $5) AS month_expenses,
        (SELECT MAX(sa.created_at) FROM sales sa WHERE sa.shop_id = s.id) AS last_sale_at
       FROM shops s WHERE s.id = ANY($1)`,
      [shopIds, dayStartUTC, dayEndUTC, monthStartUTC, monthStartStr]
    ),

    // Daily combined+per-shop money received for the last 14 days (EAT days).
    db.read(
      `SELECT (t.created_at + INTERVAL '3 hours')::date AS day, t.shop_id, SUM(t.amount) AS total, COUNT(*) AS orders
       FROM (
         SELECT sa.created_at, sa.shop_id, sa.total_amount AS amount FROM sales sa
         WHERE sa.shop_id = ANY($1) AND sa.payment_method IN ('cash','lipa_namba','bank') AND sa.sale_type IS DISTINCT FROM 'pre_order' AND sa.created_at >= $2
         UNION ALL
         SELECT dp.created_at, dd.shop_id, dp.amount FROM debt_payments dp JOIN debtors dd ON dp.debtor_id = dd.id
         WHERE dd.shop_id = ANY($1) AND dp.created_at >= $2
         UNION ALL
         SELECT ip.created_at, sa.shop_id, ip.amount FROM invoice_payments ip JOIN sales sa ON ip.sale_id = sa.id
         WHERE sa.shop_id = ANY($1) AND ip.created_at >= $2
       ) t
       GROUP BY 1, 2
       ORDER BY 1 ASC`,
      [shopIds, trendStartUTC]
    ),

    // Top products across all shops (last 30 days).
    db.read(
      `SELECT si.product_name,
              SUM(si.quantity) AS qty,
              SUM(si.total_price) AS revenue,
              SUM(si.profit) AS profit
       FROM sale_items si JOIN sales sa ON si.sale_id = sa.id
       WHERE sa.shop_id = ANY($1) AND sa.created_at >= NOW() - INTERVAL '30 days'
       GROUP BY si.product_name
       ORDER BY revenue DESC LIMIT 10`,
      [shopIds]
    ),

    // Who sold what (this month), per shop.
    db.read(
      `SELECT COALESCE(NULLIF(u.name, ''), u.email, '-') AS seller_name, sa.shop_id,
              COUNT(*) AS sales_count, COALESCE(SUM(sa.total_amount), 0) AS total_sales
       FROM sales sa LEFT JOIN "user" u ON sa.seller_id = u.id
       WHERE sa.shop_id = ANY($1) AND sa.created_at >= $2
       GROUP BY 1, 2
       ORDER BY total_sales DESC LIMIT 12`,
      [shopIds, monthStartUTC]
    ),

    // Latest sales with seller + items summary.
    db.read(
      `SELECT sa.id, sa.shop_id, sa.total_amount, sa.payment_method, sa.created_at, sa.customer_name,
              COALESCE(NULLIF(u.name, ''), u.email, '-') AS seller_name,
              (SELECT STRING_AGG(si.product_name, ', ') FROM (SELECT DISTINCT product_name FROM sale_items WHERE sale_id = sa.id LIMIT 4) si) AS items
       FROM sales sa LEFT JOIN "user" u ON sa.seller_id = u.id
       WHERE sa.shop_id = ANY($1)
       ORDER BY sa.created_at DESC LIMIT 20`,
      [shopIds]
    ),
  ]);

  const shops = perShopRes.rows.map((r: any) => {
    const shopMeta = shopsRes.rows.find((s: any) => s.id === r.id) || {};
    return {
      id: r.id,
      name: r.name,
      code: shopMeta.code,
      address: shopMeta.address,
      phone: shopMeta.phone,
      email: shopMeta.email,
      logo: shopMeta.logo,
      createdAt: shopMeta.created_at,
      productCount: parseInt(r.product_count) || 0,
      stockValue: num(r.stock_value),
      lowStockCount: parseInt(r.low_stock_count) || 0,
      todayOrders: parseInt(r.today_orders) || 0,
      todaySales: num(r.today_sales),
      monthSales: num(r.month_sales),
      todayProfit: num(r.today_profit),
      unpaidDebt: num(r.unpaid_debt),
      debtorsCount: parseInt(r.debtors_count) || 0,
      monthExpenses: num(r.month_expenses),
      lastSaleAt: r.last_sale_at,
    };
  });

  const totals = shops.reduce(
    (acc: any, s: any) => ({
      todaySales: acc.todaySales + s.todaySales,
      monthSales: acc.monthSales + s.monthSales,
      todayProfit: acc.todayProfit + s.todayProfit,
      todayOrders: acc.todayOrders + s.todayOrders,
      stockValue: acc.stockValue + s.stockValue,
      productCount: acc.productCount + s.productCount,
      unpaidDebt: acc.unpaidDebt + s.unpaidDebt,
      debtorsCount: acc.debtorsCount + s.debtorsCount,
      monthExpenses: acc.monthExpenses + s.monthExpenses,
      lowStockCount: acc.lowStockCount + s.lowStockCount,
    }),
    { todaySales: 0, monthSales: 0, todayProfit: 0, todayOrders: 0, stockValue: 0, productCount: 0, unpaidDebt: 0, debtorsCount: 0, monthExpenses: 0, lowStockCount: 0 }
  );

  return {
    shops,
    totals,
    shopCount: shops.length,
    trend: trendRes.rows.map((r: any) => ({
      day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10),
      shopId: r.shop_id,
      total: num(r.total),
      orders: parseInt(r.orders) || 0,
    })),
    topProducts: topProductsRes.rows.map((r: any) => ({
      name: r.product_name,
      quantity: num(r.qty),
      revenue: num(r.revenue),
      profit: num(r.profit),
    })),
    sellers: sellersRes.rows.map((r: any) => ({
      name: r.seller_name,
      shopId: r.shop_id,
      shopName: shops.find((s: any) => s.id === r.shop_id)?.name || '-',
      salesCount: parseInt(r.sales_count) || 0,
      totalSales: num(r.total_sales),
    })),
    recentSales: recentSalesRes.rows.map((r: any) => ({
      id: r.id,
      shopId: r.shop_id,
      shopName: shops.find((s: any) => s.id === r.shop_id)?.name || '-',
      sellerName: r.seller_name,
      items: r.items,
      amount: num(r.total_amount),
      paymentMethod: r.payment_method,
      customerName: r.customer_name,
      createdAt: r.created_at,
    })),
  };
}

router.get('/overview', authMiddleware, async (c: any) => {
  try {
    const userRole = c.get('userRole') as string;
    if (!isAdminRole(userRole)) {
      return c.json({ success: false, error: 'Combined dashboard is available to business owners only' }, 403);
    }
    const shopIds = (c.get('shopIds') as string[]) || [];
    if (shopIds.length === 0) {
      return c.json({ success: true, data: { shops: [], totals: null, shopCount: 0, trend: [], topProducts: [], sellers: [], recentSales: [] } });
    }
    const data = await gatherOverview(shopIds);
    return c.json({ success: true, data });
  } catch (error: any) {
    console.error('[Combined Dashboard] Error:', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// AI business analyst for ALL shops — read-only chat (no cross-shop sale
// creation here so the shop-scoped AI can never be bypassed).
router.post('/ask', authMiddleware, async (c: any) => {
  try {
    const userRole = c.get('userRole') as string;
    if (!isAdminRole(userRole)) {
      return c.json({ success: false, error: 'Combined AI assistant is available to business owners only' }, 403);
    }
    const shopIds = (c.get('shopIds') as string[]) || [];
    const { question, history } = await c.req.json();
    if (!question || !question.trim()) {
      return c.json({ success: false, error: 'Question is required' }, 400);
    }

    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      return c.json({ success: true, data: { answer: 'AI msaidizi anahitaji DEEPSEEK_API_KEY kusanidiwa.' } });
    }

    const data = await gatherOverview(shopIds);
    const fmt = (n: number) => Number(n || 0).toLocaleString();

    const shopLines = data.shops.map((s: any) => (
      `- ${s.name}: Mauzo leo TZS ${fmt(s.todaySales)} (oda ${s.todayOrders}) | Mauzo mwezi TZS ${fmt(s.monthSales)} | Faida leo TZS ${fmt(s.todayProfit)} | Thamani ya bidhaa TZS ${fmt(s.stockValue)} (${s.productCount} bidhaa, ${s.lowStockCount} chache) | Madeni TZS ${fmt(s.unpaidDebt)} (wadeni ${s.debtorsCount}) | Matumizi mwezi TZS ${fmt(s.monthExpenses)}`
    )).join('\n');

    const productLines = data.topProducts.slice(0, 8).map((p: any) => (
      `- ${p.name}: ${p.quantity} zimeuzwa, mapato TZS ${fmt(p.revenue)}, faida TZS ${fmt(p.profit)}`
    )).join('\n');

    const sellerLines = data.sellers.slice(0, 8).map((s: any) => (
      `- ${s.name} (${s.shopName}): mauzo ${s.salesCount}, jumla TZS ${fmt(s.totalSales)}`
    )).join('\n');

    const recentLines = data.recentSales.slice(0, 10).map((s: any) => (
      `- ${s.shopName} | ${s.sellerName} | ${s.items || '-'} | TZS ${fmt(s.amount)} | ${s.paymentMethod}`
    )).join('\n');

    const context = `BIASHARA ZA MTUMIAJI (${data.shopCount} maduka) — MUHTASARI
Jumla ya mauzo ya leo: TZS ${fmt(data.totals.todaySales)} (oda ${data.totals.todayOrders})
Jumla ya mauzo ya mwezi huu: TZS ${fmt(data.totals.monthSales)}
Jumla ya faida ya leo: TZS ${fmt(data.totals.todayProfit)}
Thamani ya bidhaa zote (stock): TZS ${fmt(data.totals.stockValue)} (${data.totals.productCount} bidhaa)
Madeni yote yanayodaiwa: TZS ${fmt(data.totals.unpaidDebt)} (wadeni ${data.totals.debtorsCount})
Matumizi ya mwezi huu: TZS ${fmt(data.totals.monthExpenses)}
Bidhaa chache (low stock): ${data.totals.lowStockCount}

KWA KILA DUKA:
${shopLines}

BIDHAA ZINAZOUZWA ZAIDI (siku 30):
${productLines || '- hakuna data'}

WANAOUZA ZAIDI (mwezi huu):
${sellerLines || '- hakuna data'}

MAUZO YA KARIBUNI:
${recentLines || '- hakuna data'}`;

    const historyMessages = (history || []).slice(-10).map((m: any) => ({ role: m.role, content: m.content }));

    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-flash',
        messages: [
          {
            role: 'system',
            content: `Wewe ni "AI Mchambuzi wa Biashara" wa ALFEAN ENTERPRISES (Hardware Store System) Tanzania. Unachambua biashara ZOTE za mmiliki na kujibu kwa Kiswahili kwa ufupi na kwa namba halisi.

Kanuni:
- Jibu kwa Kiswahili rahisi, kwa muhtasari mfupi (aya chache au bullet).
- Tumia namba halisi kutoka DATA. Usibuni namba.
- Linganisha maduka (duka gani linafanya vizuri, lipi linahitaji uangalizi).
- Toa ushauri wa vitendo: bidhaa gani iongezwe, madeni yafuatiliwe, matumizi yapunguzwe.
- Kama data haitoshi kujibu swali, sema hivyo na pendekeza swali jingine.

DATA HALISI YA BIASHARA ZOTE:
${context}`
          },
          ...historyMessages,
          { role: 'user', content: question }
        ],
        max_tokens: 1200,
        temperature: 0.3
      })
    });

    if (!response.ok) {
      return c.json({ success: true, data: { answer: 'AI haipatikani kwa sasa. Tafadhali jaribu tena.' } });
    }

    const result: any = await response.json();
    const answer = result.choices?.[0]?.message?.content || 'Samahani, sikuweza kujibu swali hilo.';
    return c.json({ success: true, data: { answer } });
  } catch (error: any) {
    console.error('[Combined AI] Error:', error.message);
    return c.json({ success: false, error: error.message }, 500);
  }
});

export default router;
