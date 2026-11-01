import cache from "../../utils/cache.js";
import type { z } from "zod";
import { db } from "../../config/database.js";
import { formatPhone, generateOfflineId } from "../../utils/helpers.js";
import type { createSaleSchema, saleQuerySchema, updateSaleSchema } from "./sale.schema.js";

// TTL presets
const TTL = {
  SHORT: 30,
  MEDIUM: 300,
  LONG: 1800,
  HOUR: 3600,
};

type CreateSaleInput = z.infer<typeof createSaleSchema>;
type UpdateSaleInput = z.infer<typeof updateSaleSchema>;
type SaleQueryInput = z.infer<typeof saleQuerySchema>;

export class SaleService {
  // Find all sales with read pool
  async findAll(query: SaleQueryInput, tenantId: string, userRole: string, userShops: string[]) {
    const {
      shopId,
      sellerId,
      paymentMethod,
      startDate,
      endDate,
      page = 1,
      limit = 20,
      includeUnpaid,
      saleType
    } = query;
    
    // Allow large limits (1000/5000/All) but cap to avoid unbounded results.
    const safeLimit = Math.min(Math.max(limit, 1), 100000);
    const offset = (page - 1) * safeLimit;
    
    // Build WHERE clause and params
    const conditions: string[] = [];
    const params: any[] = [];
    
    // Handle shop filtering based on user role and shops
    if (shopId) {
      // If a specific shopId is requested, use it directly
      conditions.push('s.shop_id = $1');
      params.push(shopId);
    } else if (userRole === 'developer') {
      // Super admin with no shop filter can access all shops - no conditions needed
    } else if (userShops && userShops.length > 0) {
      // User is limited to specific shops
      conditions.push('s.shop_id = ANY($1::uuid[])');
      params.push(userShops);
    } else {
      // No shops assigned - return empty result
      return {
        sales: [],
        summary: {
          totalSales: 0,
          totalAmount: 0,
          totalCash: 0,
          totalLipaNamba: 0,
          totalDebt: 0,
          totalBank: 0,
          totalProfit: 0,
          totalExpenses: 0,
          totalDebtCollected: 0,
          totalDebtOutstanding: 0,
          netProfit: 0,
        },
        pagination: {
          page,
          limit,
          total: 0,
          totalPages: 0
        }
      };
    }
    
    // The sales LIST hides unpaid invoices by default (unless includeUnpaid is
    // set, e.g. for the invoice list page). The summary cards count every sale
    // so this page, the reports page and the dashboard agree on totals.

    if (saleType) {
      conditions.push(`s.sale_type = $${params.length + 1}`);
      params.push(saleType);
    }

    if (sellerId) {
      conditions.push(`s.seller_id = $${params.length + 1}`);
      params.push(sellerId);
    }
    
    if (paymentMethod) {
      conditions.push(`s.payment_method = $${params.length + 1}`);
      params.push(paymentMethod);
    }
    
    if (startDate) {
      conditions.push(`s.created_at >= $${params.length + 1}`);
      params.push(startDate);
    }
    
    if (endDate) {
      conditions.push(`s.created_at <= $${params.length + 1}`);
      params.push(endDate);
    }
    
    // List-only filter applied after every common (shop/date/seller/payment/
    // saleType) condition so the list uses the same param list as the summary.
    const listConditions = [...conditions];
    if (includeUnpaid !== 'true' && !saleType) {
      listConditions.push("(s.sale_type IS DISTINCT FROM 'invoice' OR s.payment_status = 'paid')");
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const listWhereClause = listConditions.length > 0 ? 'WHERE ' + listConditions.join(' AND ') : '';

    // Pooled period figures (madeni + matumizi). These are scoped to the same
    // shops and date range as the sales list, but ignore sales-table filters
    // like payment method or seller so the totals always reconcile.
    const pooledScope = (alias: string) => {
      if (shopId) return { sql: `${alias}.shop_id = $1`, params: [shopId] as any[] };
      if (userShops && userShops.length > 0) return { sql: `${alias}.shop_id = ANY($1::uuid[])`, params: [userShops] as any[] };
      return { sql: 'TRUE', params: [] as any[] };
    };

    const expenseScope = pooledScope('e');
    const expenseConditions = [expenseScope.sql];
    const expenseParams = [...expenseScope.params];
    if (startDate) { expenseConditions.push(`e.date >= $${expenseParams.length + 1}::date`); expenseParams.push(startDate); }
    if (endDate) { expenseConditions.push(`e.date <= $${expenseParams.length + 1}::date`); expenseParams.push(endDate); }
    const expenseWhere = 'WHERE ' + expenseConditions.join(' AND ');

    const debtPayScope = pooledScope('d');
    const debtPayConditions = [debtPayScope.sql];
    const debtPayParams = [...debtPayScope.params];
    if (startDate) { debtPayConditions.push(`dp.created_at >= $${debtPayParams.length + 1}`); debtPayParams.push(startDate); }
    if (endDate) { debtPayConditions.push(`dp.created_at <= $${debtPayParams.length + 1}`); debtPayParams.push(endDate); }
    const debtPayWhere = 'WHERE ' + debtPayConditions.join(' AND ');

    const outstandingScope = pooledScope('d');
    const outstandingWhere = `WHERE ${outstandingScope.sql} AND COALESCE(d.status, 'unpaid') <> 'paid'`;
    
    // Use read pool for queries
    const [countResult, summaryResult, profitResult, expenseResult, debtPayResult, debtOutstandingResult] = await Promise.all([
      db.read(`SELECT COUNT(*) AS count FROM sales s ${listWhereClause}`, params),
      db.read(
        `SELECT 
          COUNT(*) as total_sales,
          COALESCE(SUM(s.total_amount), 0) as total_amount,
          COALESCE(SUM(CASE WHEN s.payment_method = 'cash' THEN s.total_amount ELSE 0 END), 0) as total_cash,
          COALESCE(SUM(CASE WHEN s.payment_method = 'lipa_namba' THEN s.total_amount ELSE 0 END), 0) as total_lipa_namba,
          COALESCE(SUM(CASE WHEN s.payment_method = 'debt' THEN s.total_amount ELSE 0 END), 0) as total_debt,
          COALESCE(SUM(CASE WHEN s.payment_method = 'bank' THEN s.total_amount ELSE 0 END), 0) as total_bank
         FROM sales s
         ${whereClause}`,
        params
      ),
      // Profit must cover the FULL filtered range, not just the current page,
      // so totals stay correct when the user picks All / a big page size.
      db.read(
        `SELECT COALESCE(SUM(si.profit), 0) as total_profit
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         ${whereClause}`,
        params
      ),
      db.read(`SELECT COALESCE(SUM(e.amount), 0) as total FROM expenses e ${expenseWhere}`, expenseParams),
      db.read(
        `SELECT COALESCE(SUM(dp.amount), 0) as total FROM debt_payments dp
         JOIN debtors d ON dp.debtor_id = d.id
         ${debtPayWhere}`,
        debtPayParams
      ),
      db.read(
        `SELECT COALESCE(SUM(d.total_amount - COALESCE(d.paid_amount, 0)), 0) as total
         FROM debtors d ${outstandingWhere}`,
        outstandingScope.params
      ),
    ]);
    const total = parseInt(countResult.rows[0].count);

    const totalProfitValue = parseFloat(profitResult.rows[0]?.total_profit || 0);
    const totalExpensesValue = parseFloat(expenseResult.rows[0]?.total || 0);
    const pooledSummary = {
      totalExpenses: totalExpensesValue,
      totalDebtCollected: parseFloat(debtPayResult.rows[0]?.total || 0),
      totalDebtOutstanding: parseFloat(debtOutstandingResult.rows[0]?.total || 0),
      netProfit: totalProfitValue - totalExpensesValue,
    };
    
    if (total === 0) {
      return {
        sales: [],
        summary: {
          totalSales: 0,
          totalAmount: 0,
          totalCash: 0,
          totalLipaNamba: 0,
          totalDebt: 0,
          totalBank: 0,
          totalProfit: totalProfitValue,
          ...pooledSummary,
        },
        pagination: {
          page,
          limit,
          total: 0,
          totalPages: 0
        }
      };
    }
    
    const queryParams = [...params, safeLimit, offset];
    const limitOffsetIndex = params.length + 1;
    
    const result = await db.read(
      `SELECT s.*, 
              u.first_name as seller_first_name, 
              u.last_name as seller_last_name,
              u.email as seller_email,
              sh.name as shop_name,
               COALESCE(SUM(si.quantity), 0) as item_count
       FROM sales s
       LEFT JOIN "user" u ON s.seller_id = u.id
       JOIN shops sh ON s.shop_id = sh.id
       LEFT JOIN sale_items si ON s.id = si.sale_id
       ${listWhereClause}
       GROUP BY s.id, u.first_name, u.last_name, u.email, sh.name
       ORDER BY s.created_at DESC
       LIMIT $${limitOffsetIndex} OFFSET $${limitOffsetIndex + 1}`,
      queryParams
    );

    const saleIds = result.rows.map((row: any) => row.id);
    let itemsMap: Record<string, any[]> = {};
    if (saleIds.length > 0) {
      const itemsResult = await db.read(
        `SELECT si.*, p.current_stock as product_stock, p.buying_price as current_buying_price
         FROM sale_items si 
         LEFT JOIN products p ON si.product_id = p.id 
         WHERE si.sale_id = ANY($1)`,
        [saleIds]
      );
      itemsMap = itemsResult.rows.reduce((acc: any, item: any) => {
        if (!acc[item.sale_id]) acc[item.sale_id] = [];
        const unitPrice = parseFloat(item.unit_price);
        const buyingPrice = parseFloat(item.buying_price_at_sale) || parseFloat(item.current_buying_price) || 0;
        const quantity = parseFloat(item.quantity);
        const discount = parseFloat(item.discount || 0);
        const profit = (unitPrice * quantity - discount) - (buyingPrice * quantity);
        acc[item.sale_id].push({
          id: item.id,
          productId: item.product_id,
          productName: item.product_name,
          quantity,
          fractionType: item.fraction_type || 'whole',
          unitPrice,
          buyingPrice,
          profit,
          discount,
          totalPrice: parseFloat(item.total_price),
          currentStock: item.product_stock !== null ? parseFloat(item.product_stock) : null,
          unitType: item.unit_type || 'PCS',
        });
        return acc;
      }, {});
    }

    const salesWithProfit = result.rows.map((row: any) => {
      const items = itemsMap[row.id] || [];
      const saleProfit = items.reduce((sum, item) => sum + (item.profit || 0), 0);
      return {
        ...this.formatSale(row),
        items,
        profit: saleProfit
      };
    });
    
    return {
      sales: salesWithProfit,
      summary: {
        totalSales: parseInt(summaryResult.rows[0].total_sales),
        totalAmount: parseFloat(summaryResult.rows[0].total_amount),
        totalCash: parseFloat(summaryResult.rows[0].total_cash),
        totalLipaNamba: parseFloat(summaryResult.rows[0].total_lipa_namba),
        totalDebt: parseFloat(summaryResult.rows[0].total_debt),
        totalBank: parseFloat(summaryResult.rows[0].total_bank),
        totalProfit: totalProfitValue,
        ...pooledSummary,
      },
      pagination: {
        page,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit)
      }
    };
  }
  
  // Find by ID with caching
  async findById(id: string, tenantId: string) {
    const cacheKey = `sale:${id}`;
    
    return cache.getOrSet(cacheKey, async () => {
      const result = await db.read(
        `SELECT s.*, 
                u.first_name as seller_first_name, 
                u.last_name as seller_last_name,
                u.email as seller_email,
                sh.name as shop_name
         FROM sales s
         LEFT JOIN "user" u ON s.seller_id = u.id
         JOIN shops sh ON s.shop_id = sh.id
         WHERE s.id = $1`,
        [id]
      );
      
      if (result.rows.length === 0) {
        throw new Error('Sale not found');
      }
      
      const sale = result.rows[0];
      
      const itemsResult = await db.read(
        `SELECT si.*, p.name as product_name, p.selling_price as current_selling_price, p.buying_price as current_buying_price
         FROM sale_items si
         LEFT JOIN products p ON si.product_id = p.id
         WHERE si.sale_id = $1`,
        [id]
      );
      
      const totalProfit = itemsResult.rows.reduce((sum, item) => {
        const unitPrice = parseFloat(item.unit_price) || 0;
        const buyingPrice = parseFloat(item.buying_price_at_sale) || parseFloat(item.current_buying_price) || 0;
        const quantity = parseFloat(item.quantity) || 0;
        const discount = parseFloat(item.discount || 0);
        const profit = (unitPrice * quantity - discount) - (buyingPrice * quantity);
        return sum + profit;
      }, 0);
      
      return {
        ...this.formatSale(sale),
        items: itemsResult.rows.map(item => {
          const unitPrice = parseFloat(item.unit_price) || 0;
          const buyingPrice = parseFloat(item.buying_price_at_sale) || parseFloat(item.current_buying_price) || 0;
          const quantity = parseFloat(item.quantity) || 0;
          const discount = parseFloat(item.discount || 0);
          const profit = (unitPrice * quantity - discount) - (buyingPrice * quantity);
          const totalPrice = parseFloat(item.total_price) || unitPrice * quantity;
          return {
            id: item.id,
            productId: item.product_id,
            productName: item.product_name || 'Unknown Product',
            description: item.product_name || 'Unknown Product',
            quantity,
            fractionType: item.fraction_type || 'whole',
            unitPrice,
            buyingPrice,
            profit,
            discount,
            totalPrice,
            total: totalPrice,
            dimensionL: item.dimension_l,
            dimensionW: item.dimension_w,
            dimensionH: item.dimension_h,
            dimensionLabel: item.dimension_label,
            unitType: item.unit_type,
          };
        }),
        totalProfit,
        profit: totalProfit
      };
    }, TTL.SHORT);
  }
  
  // Create sale with write pool and cache invalidation
  async create(data: CreateSaleInput, sellerId: string, isOffline: boolean = false) {
    const {
      shopId,
      items,
      paymentMethod,
      amountPaid,
      discountAmount,
      customerName,
      customerPhone,
      customerEmail,
      notes,
      bankName,
      saleDate,
      source,
      offlineId: clientOfflineId
    } = data;

    // Backdating: when the caller supplies a past sale date, keep today's
    // time-of-day but use the chosen calendar date so the sale is counted in
    // that day's reports. Future dates are not allowed.
    let saleCreatedAt: Date = new Date();
    if (saleDate) {
      const [y, m, d] = String(saleDate).split('-').map(Number);
      if (!y || !m || !d || Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) {
        throw new Error('Invalid sale date');
      }
      const chosen = new Date(y, m - 1, d);
      if (chosen.getTime() > Date.now()) {
        throw new Error('Sale date cannot be in the future');
      }
      const now = new Date();
      saleCreatedAt = new Date(y, m - 1, d, now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
    }
    
    return db.transaction(async (client) => {
      // Idempotency for offline/POS sales: if the client reference already
      // produced a sale (the first attempt committed but its response was lost,
      // so the queue replayed it), return that sale instead of creating a
      // duplicate and deducting stock twice.
      if (clientOfflineId) {
        const existingResult = await client.query(
          `SELECT * FROM sales WHERE offline_id = $1 LIMIT 1`,
          [clientOfflineId]
        );
        if (existingResult.rows.length > 0) {
          const existing = existingResult.rows[0];
          return {
            sale: {
              id: existing.id,
              offlineId: existing.offline_id,
              totalAmount: parseFloat(existing.total_amount),
              paymentMethod: existing.payment_method,
              amountPaid: parseFloat(existing.amount_paid),
              changeDue: parseFloat(existing.change_due),
              items: [],
              createdAt: existing.created_at,
              bankName: existing.bank_name,
              duplicate: true,
            }
          };
        }
      }

      // Validate and calculate totals
      let totalAmount = 0;
      const saleItems = [];
      const productUpdates: { id: string; newStock: number }[] = [];

      // Load and lock the cart's products in one query. The previous loop did
      // one SELECT per line item, which held the write connection longer and
      // made multi-item sales contend with other cashiers.
      const productIds = [...new Set(items.map(item => item.productId).filter(Boolean))] as string[];
      const productsResult = productIds.length > 0
        ? await client.query(
            `SELECT * FROM products
             WHERE id = ANY($1::uuid[]) AND shop_id = $2 AND is_active = true
             ORDER BY id
             FOR UPDATE`,
            [productIds, shopId]
          )
        : { rows: [] };
      const productsById = new Map(productsResult.rows.map((product: any) => [product.id, product]));

      const customUnitCodes = [...new Set(items.map(item => {
        const product = productsById.get(item.productId || '');
        return product && item.unitType && item.unitType !== product.unit_type
          ? item.unitType
          : null;
      }).filter(Boolean))] as string[];
      const customUnitsByCode = new Map<string, number>();
      if (customUnitCodes.length > 0) {
        const customUnitsResult = await client.query(
          `SELECT code, stock_multiplier
           FROM shop_units
           WHERE shop_id = $1 AND code = ANY($2::text[]) AND is_active = true`,
          [shopId, customUnitCodes]
        );
        for (const unit of customUnitsResult.rows) {
          customUnitsByCode.set(unit.code, parseFloat(unit.stock_multiplier));
        }
      }
      
      for (const item of items) {
        const product = productsById.get(item.productId || '');
        if (!product) {
          throw new Error(`Product ${item.productId} not found`);
        }

        const currentStock = parseFloat(product.current_stock);
        const sellQuantity = item.quantity;
        const fractionType = item.fractionType || 'whole';
        const saleUnitType = item.unitType || product.unit_type || 'PCS';
        
        // Calculate unit price based on fraction type
        let fractionPrices: Record<string, number> = {};
        let enableFractions = false;
        let unitConversions: Record<string, any> = {};
        
        try {
          fractionPrices = typeof product.fraction_prices === 'string' ? JSON.parse(product.fraction_prices) : (product.fraction_prices || {});
        } catch { fractionPrices = {}; }

        try {
          unitConversions = typeof product.unit_conversions === 'string' ? JSON.parse(product.unit_conversions) : (product.unit_conversions || {});
        } catch { unitConversions = {}; }
        
        enableFractions = product.enable_fractions || false;
        
        // Fraction multipliers for stock deduction
        const fractionMultipliers: Record<string, number> = {
          'whole': 1,
          'half': 0.5,
          'quarter': 0.25,
          'third': 1/3,
          'two_thirds': 2/3,
          'custom': 1
        };

        // Calculate stock deduction based on sale unit type
        let stockDeduction = sellQuantity;
        let unitPrice = parseFloat(product.selling_price);

        // If selling by dimensions (SQM), calculate area and deduct from stock
        if (product.requires_dimensions || product.unit_type === 'SQM') {
          const dimL = item.dimensionL || 0;
          const dimW = item.dimensionW || 0;
          const dimensionUnit = product.dimension_unit || 'm';
          let area;
          if (dimensionUnit === 'cm') {
            // Dimensions are in cm, convert to m²: (cm × cm) / 10000 = m²
            area = (dimL * dimW) / 10000;
          } else {
            // Dimensions are in metres
            area = dimL * dimW;
          }
          stockDeduction = area * sellQuantity; // area × quantity pieces
          unitPrice = item.totalPrice ? item.totalPrice / sellQuantity : (area * parseFloat(product.selling_price));
        }
        // If selling by a different unit type, apply conversion factor
        else if (saleUnitType !== product.unit_type && unitConversions[saleUnitType]) {
          const conversionFactor = unitConversions[saleUnitType].factor || 1;
          stockDeduction = sellQuantity * conversionFactor;
          if (unitConversions[saleUnitType].price) {
            unitPrice = unitConversions[saleUnitType].price;
          }
        }
        // Custom unit: look up stock_multiplier from shop_units
        else if (saleUnitType && saleUnitType !== product.unit_type) {
          const stockMultiplier = customUnitsByCode.get(saleUnitType);
          if (stockMultiplier !== undefined) {
            stockDeduction = sellQuantity * stockMultiplier;
          }
        }
        // Fraction-based selling (legacy)
        else if (fractionType !== 'whole') {
          const stockMultiplier = fractionMultipliers[fractionType] || 1;
          stockDeduction = sellQuantity * stockMultiplier;
          if (fractionPrices[fractionType] !== undefined) {
            unitPrice = fractionPrices[fractionType];
          } else {
            unitPrice = parseFloat(product.selling_price) * stockMultiplier;
          }
        }
        
        if (currentStock < stockDeduction) {
          throw new Error(`Insufficient stock for ${product.name}. Available: ${currentStock}, needed: ${stockDeduction}`);
        }
        
        // Negotiated price: the cashier can agree a different price with this
        // particular customer (e.g. a boss buying at 10,000 instead of the
        // standard 7,000). The product's own selling_price is never modified,
        // so other customers still pay the standard price.
        if (item.unitPrice !== undefined && item.unitPrice !== null && !Number.isNaN(Number(item.unitPrice))) {
          unitPrice = Number(item.unitPrice);
        }

        const itemDiscount = item.discount || 0;
        const itemTotal = item.totalPrice !== undefined ? item.totalPrice : (unitPrice * sellQuantity) - itemDiscount;
        const itemProfit = itemTotal - (parseFloat(product.buying_price) * stockDeduction);
        totalAmount += itemTotal;
        
        saleItems.push({
          productId: item.productId,
          productName: product.name,
          quantity: sellQuantity,
          fractionType,
          unitType: saleUnitType,
          unitPrice,
          discount: itemDiscount,
          buyingPriceAtSale: parseFloat(product.buying_price),
          totalPrice: itemTotal,
          profit: itemProfit,
          stockDeduction,
          dimensionL: item.dimensionL || null,
          dimensionW: item.dimensionW || null,
          dimensionH: item.dimensionH || null,
          dimensionLabel: item.dimensionLabel || null,
        });
        
        productUpdates.push({
          id: item.productId!,
          newStock: currentStock - stockDeduction
        });
        // Keep duplicate product lines in the same cart honest while the row
        // lock protects against another cashier selling the same stock.
        product.current_stock = currentStock - stockDeduction;
      }
      
      totalAmount -= discountAmount || 0;
      if (totalAmount < 0) totalAmount = 0;
      
      const changeDue = paymentMethod === 'cash' ? Math.max(0, amountPaid - totalAmount) : 0;
      const finalAmountPaid = paymentMethod === 'cash' ? amountPaid : 
                             (paymentMethod === 'lipa_namba' || paymentMethod === 'bank') ? totalAmount : 0;
      
      const offlineId = clientOfflineId || (isOffline ? generateOfflineId('SALE') : null);
      // Use full seller_id - the column is now VARCHAR(255)
      const safeSellerId = sellerId;
      
      let saleResult;
      try {
        const saleType = paymentMethod === 'debt' ? 'debt' : 'normal';
        const saleSource = source || 'pos';
        saleResult = await client.query(
          `INSERT INTO sales (shop_id, seller_id, offline_id, total_amount, payment_method, 
           amount_paid, change_due, discount_amount, customer_name, customer_phone, customer_email, notes, bank_name, sale_type, source, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
           RETURNING *`,
          [shopId, safeSellerId, offlineId, totalAmount, paymentMethod, finalAmountPaid, changeDue,
           discountAmount || 0, customerName || null, customerPhone ? formatPhone(customerPhone) : null,
           customerEmail || null, notes || null, bankName || null, saleType, saleSource, saleCreatedAt]
        );
      } catch (saleErr: any) {
        console.error('[SaleService.create] Sale insert FULL error:', JSON.stringify(saleErr, Object.getOwnPropertyNames(saleErr)));
        throw saleErr;
      }
      
      const sale = saleResult.rows[0];
      
      // Insert all line items in one round-trip and aggregate stock updates by
      // product. This shortens the write transaction for busy multi-item carts.
      const saleItemValues = saleItems.flatMap(item => [
        sale.id, item.productId, item.productName, item.quantity, item.fractionType,
        item.unitType, item.unitPrice, item.discount, item.buyingPriceAtSale,
        item.totalPrice, item.profit, item.dimensionL, item.dimensionW,
        item.dimensionH, item.dimensionLabel,
      ]);
      const saleItemPlaceholders = saleItems.map((_, rowIndex) => {
        const start = rowIndex * 15 + 1;
        return `(${Array.from({ length: 15 }, (_, index) => `$${start + index}`).join(', ')})`;
      }).join(', ');
      await client.query(
        `INSERT INTO sale_items (sale_id, product_id, product_name, quantity, fraction_type, unit_type, unit_price, discount, buying_price_at_sale, total_price, profit, dimension_l, dimension_w, dimension_h, dimension_label)
         VALUES ${saleItemPlaceholders}`,
        saleItemValues,
      );

      const stockByProduct = new Map<string, number>();
      for (const item of saleItems) {
        if (item.productId && item.stockDeduction > 0) {
          stockByProduct.set(
            item.productId,
            (stockByProduct.get(item.productId) || 0) + item.stockDeduction,
          );
        }
      }
      if (stockByProduct.size > 0) {
        const stockEntries = Array.from(stockByProduct.entries());
        const stockValues = stockEntries.flatMap(([productId, deduction]) => [productId, deduction]);
        const stockPlaceholders = stockEntries.map((_, rowIndex) => {
          const start = rowIndex * 2 + 1;
          return `($${start}, $${start + 1})`;
        }).join(', ');
        await client.query(
          `UPDATE products AS p
           SET current_stock = p.current_stock - v.deduction::numeric, updated_at = NOW()
           FROM (VALUES ${stockPlaceholders}) AS v(id, deduction)
           WHERE p.id = v.id::uuid`,
          stockValues,
        );
      }
      
      // Create debtor record if debt payment
      if (paymentMethod === 'debt' && customerPhone) {
        const debtorResult = await client.query(
          `INSERT INTO debtors (shop_id, sale_id, customer_name, customer_phone, customer_email, total_amount, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'unpaid')
           RETURNING id`,
          [shopId, sale.id, customerName || null, formatPhone(customerPhone), customerEmail || null, totalAmount]
        );
        const debtorId = debtorResult.rows[0].id;

        // Copy sale items to debt_items so they appear in the debtor's item list
        const debtItemValues = saleItems.flatMap(item => [
          debtorId, item.productId, item.productName, item.quantity,
          item.unitPrice, item.discount, item.totalPrice, item.buyingPriceAtSale,
        ]);
        const debtItemPlaceholders = saleItems.map((_, rowIndex) => {
          const start = rowIndex * 8 + 1;
          return `(${Array.from({ length: 8 }, (_, index) => `$${start + index}`).join(', ')})`;
        }).join(', ');
        await client.query(
          `INSERT INTO debt_items (debtor_id, product_id, product_name, quantity, unit_price, discount, total_price, buying_price)
           VALUES ${debtItemPlaceholders}`,
          debtItemValues,
        );
      }
      
      // Invalidate caches immediately for real-time updates
      cache.invalidateByPrefix('sale:');
      cache.invalidateByPrefix('stats:');
    cache.invalidateByPrefix('reports:');
      cache.invalidateByPrefix('products:shop');
      productUpdates.forEach(p => {
        cache.invalidate(`product:${p.id}`);
      });
      
      return {
        sale: {
          id: sale.id,
          offlineId: sale.offline_id,
          totalAmount: parseFloat(sale.total_amount),
          paymentMethod: sale.payment_method,
          amountPaid: parseFloat(sale.amount_paid),
          changeDue: parseFloat(sale.change_due),
          items: saleItems,
          createdAt: sale.created_at,
          bankName: sale.bank_name
        }
      };
    });
  }

  async update(id: string, data: UpdateSaleInput, userId: string) {
    return db.transaction(async (client) => {
      const existing = await client.query('SELECT * FROM sales WHERE id = $1', [id]);
      if (existing.rows.length === 0) throw new Error('Sale not found');
      const sale = existing.rows[0];

      // Build dynamic update for sale record
      const updates: string[] = [];
      const vals: any[] = [];
      let idx = 1;

      const addField = (col: string, val: any) => {
        if (val !== undefined) {
          updates.push(`${col} = $${idx++}`);
          vals.push(val);
        }
      };

      addField('customer_name', data.customerName ?? null);
      addField('customer_phone', data.customerPhone ? formatPhone(data.customerPhone) : null);
      addField('customer_email', data.customerEmail ?? null);
      addField('customer_company', data.customerCompany ?? null);
      addField('customer_address', data.customerAddress ?? null);
      addField('customer_tin', data.customerTin ?? null);
      addField('customer_vrn', data.customerVrn ?? null);
      addField('notes', data.notes ?? null);
      addField('due_date', data.dueDate ?? null);
      addField('payment_method', data.paymentMethod ?? null);
      addField('payment_reference', data.paymentReference ?? null);
      if (data.discountAmount !== undefined) {
        addField('discount_amount', data.discountAmount);
      }

      if (updates.length > 0) {
        updates.push(`updated_at = NOW()`);
        const query = `UPDATE sales SET ${updates.join(', ')} WHERE id = $${idx++} RETURNING *`;
        vals.push(id);
        await client.query(query, vals);
      }

      // Handle items update if provided
      if (data.items && data.items.length > 0) {
        // 1. Reverse stock for old items
        const oldItems = await client.query('SELECT * FROM sale_items WHERE sale_id = $1', [id]);
        for (const oldItem of oldItems.rows) {
          if (oldItem.product_id) {
            const qty = parseFloat(oldItem.quantity) || 0;
            if (qty > 0) {
              await client.query(
                'UPDATE products SET current_stock = current_stock + $1 WHERE id = $2',
                [qty, oldItem.product_id]
              );
            }
          }
        }

        // 2. Delete old items
        await client.query('DELETE FROM sale_items WHERE sale_id = $1', [id]);

        // 3. Calculate totals and insert new items
        let totalAmount = 0;
        const insertItems = [];

        for (const item of data.items) {
          const unitPrice = item.unitPrice || 0;
          const itemDiscount = item.discount || 0;
          const itemTotal = (unitPrice * item.quantity) - itemDiscount;
          totalAmount += itemTotal;

          let buyingPrice = 0;
          if (item.productId) {
            const prodRes = await client.query(
              'SELECT buying_price FROM products WHERE id = $1',
              [item.productId]
            );
            if (prodRes.rows.length > 0) {
              buyingPrice = parseFloat(prodRes.rows[0].buying_price) || 0;
            }
            // Deduct stock
            await client.query(
              'UPDATE products SET current_stock = current_stock - $1 WHERE id = $2',
              [item.quantity, item.productId]
            );
          }

          const profit = itemTotal - (buyingPrice * item.quantity);

          insertItems.push({
            productId: item.productId || null,
            productName: item.productName,
            quantity: item.quantity,
            unitPrice,
            discount: itemDiscount,
            buyingPriceAtSale: buyingPrice,
            totalPrice: itemTotal,
            profit,
            fractionType: item.fractionType || 'whole',
            unitType: item.unitType || null,
          });
        }

        // Apply discount amount
        const discountAmount = data.discountAmount !== undefined ? data.discountAmount : (parseFloat(sale.discount_amount) || 0);
        totalAmount -= discountAmount;

        // Update sale totals
        await client.query(
          `UPDATE sales SET total_amount = $1, discount_amount = $2, updated_at = NOW() WHERE id = $3`,
          [totalAmount, discountAmount, id]
        );

        // Insert new items
        for (const ins of insertItems) {
          await client.query(
            `INSERT INTO sale_items (sale_id, product_id, product_name, quantity, fraction_type, unit_type,
             unit_price, discount, buying_price_at_sale, total_price, profit)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [id, ins.productId, ins.productName, ins.quantity, ins.fractionType, ins.unitType,
             ins.unitPrice, ins.discount, ins.buyingPriceAtSale, ins.totalPrice, ins.profit]
          );
        }
      }

      // Invalidate caches
      cache.invalidate(`sale:${id}`);
      cache.invalidateByPrefix('stats:');
    cache.invalidateByPrefix('reports:');
      cache.invalidateByPrefix('products:shop');

      return { id, updated: true };
    });
  }

  private formatSale(row: any) {
    const sellerName = row.seller_first_name && row.seller_last_name 
      ? `${row.seller_first_name} ${row.seller_last_name}` 
      : row.seller_first_name || row.seller_last_name || row.seller_email || 'Unknown Seller';
    return {
      id: row.id,
      shopId: row.shop_id,
      shopName: row.shop_name,
      sellerId: row.seller_id,
      sellerName,
      offlineId: row.offline_id,
      totalAmount: parseFloat(row.total_amount),
      paymentMethod: row.payment_method,
      amountPaid: parseFloat(row.amount_paid),
      changeDue: parseFloat(row.change_due),
      discountAmount: parseFloat(row.discount_amount),
      itemCount: parseFloat(row.item_count),
      customerName: row.customer_name,
      customerPhone: row.customer_phone,
      customerEmail: row.customer_email,
      customerCompany: row.customer_company,
      customerAddress: row.customer_address,
      customerTin: row.customer_tin,
      customerVrn: row.customer_vrn,
      invoiceSent: row.invoice_sent,
      dueDate: row.due_date,
      paymentReference: row.payment_reference,
      saleType: row.sale_type || 'normal',
      paymentStatus: row.payment_status || 'pending',
      bankName: row.bank_name,
      verificationCode: row.verification_code,
      notes: row.notes,
      createdAt: row.created_at,
      source: row.source || 'pos'
    };
  }

  async getInvoiceData(saleId: string, tenantId: string) {
    const sale = await this.findById(saleId, tenantId);
    
    const shopResult = await db.read(
      'SELECT * FROM shops WHERE id = $1',
      [sale.shopId]
    );
    
    if (shopResult.rows.length === 0) {
      throw new Error('Shop not found');
    }
    
    const shop = shopResult.rows[0];
    
    const shopCode = shop.code || 'SHOP';
    const year = new Date(sale.createdAt).getFullYear();
    const month = String(new Date(sale.createdAt).getMonth() + 1).padStart(2, '0');
    const invoiceNumber = `${shopCode}-${year}${month}-${saleId.slice(0, 6).toUpperCase()}`;
    
    const subtotal = sale.items.reduce((sum: number, item: any) => sum + item.totalPrice, 0);
    const discount = sale.discountAmount || 0;
    const total = subtotal - discount;
    
    const verificationCode = `VFD-${Date.now().toString(36).toUpperCase()}-${saleId.slice(0, 4).toUpperCase()}`;
    
    return {
      id: saleId,
      invoiceNumber,
      saleDate: sale.createdAt,
      dueDate: sale.dueDate,
      shop: {
        name: shop.name,
        businessName: shop.business_name || shop.name,
        address: shop.address || 'N/A',
        phone: shop.phone || 'N/A',
        email: shop.email || 'N/A',
        serialNumber: shop.serial_number || '',
        branchName: shop.branch_name || '',
        logo: shop.logo || '',
        invoiceFooter: shop.invoice_footer || '',
        tinNumber: shop.tin_number || '',
        vrnNumber: shop.vrn_number || ''
      },
      customer: {
        name: sale.customerName || 'Cash Customer',
        phone: sale.customerPhone || 'N/A',
        email: sale.customerEmail || '',
        company: sale.customerCompany || '',
        address: sale.customerAddress || '',
        tin: sale.customerTin || '',
        vrn: sale.customerVrn || ''
      },
      seller: {
        name: sale.sellerName
      },
      items: sale.items.map((item: any) => ({
        description: item.productName,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discount: item.discount || 0,
        total: item.totalPrice
      })),
      subtotal: subtotal,
      discount: discount,
      total: total,
      amountPaid: sale.amountPaid || 0,
      balanceDue: total - (sale.amountPaid || 0),
      paymentMethod: sale.paymentMethod,
      paymentReference: sale.paymentReference || '',
      verificationCode: verificationCode,
      notes: sale.notes || ''
    };
  }

  async createInvoiceFromData(data: any, sellerId: string, tenantId: string) {
    const { 
      shopId, 
      customerName, 
      customerPhone, 
      customerEmail,
      customerAddress,
      customerTin,
      customerVrn,
      items, 
      notes, 
      dueDate,
      paymentMethod = 'credit',
      paymentReference,
      saleType
    } = data;
    
    return db.transaction(async (client) => {
      let subtotal = 0;
      const invoiceItems = [];
      
      for (const item of items) {
        const productResult = await client.query(
            'SELECT * FROM products WHERE id = $1 AND shop_id = $2',
            [item.productId, shopId]
          );
          
          if (productResult.rows.length === 0) {
            throw new Error(`Product ${item.productId} not found`);
          }
          
          const product = productResult.rows[0];
          
          const itemTotal = item.unitPrice * item.quantity;
          subtotal += itemTotal;
          
          invoiceItems.push({
            productId: item.productId,
            productName: product.name,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            discount: 0,
            buyingPriceAtSale: product.buying_price,
            totalPrice: itemTotal,
            profit: itemTotal - (product.buying_price * item.quantity),
          });
      }
      
      const total = subtotal;
      
      const customerCompany = data.customerCompany || null;
      const paymentStatus = paymentMethod === 'cash' ? 'paid' : 'pending';
      
      const saleSource = data.source || 'pos';
      const resolvedSaleType = saleType || 'invoice';
      const saleResult = await client.query(
        `INSERT INTO sales (shop_id, seller_id, total_amount, payment_method, amount_paid, 
         customer_name, customer_phone, customer_email, customer_address, customer_tin, customer_vrn, customer_company,
         due_date, payment_reference, notes, invoice_sent, payment_status, sale_type, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, true, $16, $17, $18)
         RETURNING *`,
        [shopId, sellerId, total, paymentMethod, paymentMethod === 'cash' ? total : 0, customerName, customerPhone, 
         customerEmail, customerAddress || null, customerTin || null, customerVrn || null, customerCompany, dueDate || null, paymentReference, notes, paymentStatus, resolvedSaleType, saleSource]
      );
      
      const sale = saleResult.rows[0];
      
      for (const item of invoiceItems) {
        await client.query(
          `INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, 
           discount, buying_price_at_sale, total_price, profit)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [sale.id, item.productId, item.productName, item.quantity, item.unitPrice, 
           item.discount, item.buyingPriceAtSale, item.totalPrice, item.profit]
        );
        
      }
      
      // Invalidate cache
      cache.invalidateByPrefix('sale:');
      cache.invalidateByPrefix('stats:');
    cache.invalidateByPrefix('reports:');
      cache.invalidateByPrefix('products:shop');
      
      // Get seller info directly from the transaction
      const sellerResult = await client.query(
        'SELECT first_name, last_name, email FROM "user" WHERE id = $1',
        [sellerId]
      );
      const seller = sellerResult.rows[0];
      const sellerName = seller ? `${seller.first_name} ${seller.last_name}` : seller?.email || 'Unknown Seller';
      
      // Get shop info with logo and invoice_footer
      const shopInfoResult = await client.query('SELECT name, logo, invoice_footer, tin_number, vrn_number FROM shops WHERE id = $1', [shopId]);
      const shopInfo = shopInfoResult.rows[0];
      
      // Return formatted data directly
      return {
        id: sale.id,
        shopId: sale.shop_id,
        shopName: shopInfo?.name || 'Unknown Shop',
        shop: {
          name: shopInfo?.name || 'Unknown Shop',
          businessName: shopInfo?.name || 'Unknown Shop',
          address: 'N/A',
          phone: 'N/A',
          email: '',
          serialNumber: '',
          branchName: '',
          logo: shopInfo?.logo || '',
          invoiceFooter: shopInfo?.invoice_footer || '',
          tinNumber: shopInfo?.tin_number || '',
          vrnNumber: shopInfo?.vrn_number || ''
        },
        sellerId: sale.seller_id,
        sellerName,
        offlineId: sale.offline_id,
        totalAmount: parseFloat(sale.total_amount),
        paymentMethod: sale.payment_method,
        amountPaid: parseFloat(sale.amount_paid),
        changeDue: parseFloat(sale.change_due),
        discountAmount: parseFloat(sale.discount_amount || 0),
        itemCount: invoiceItems.length,
        customerName: sale.customer_name,
        customerPhone: sale.customer_phone,
        customerEmail: sale.customer_email,
        customerAddress: sale.customer_address,
        customerTin: sale.customer_tin,
        customerVrn: sale.customer_vrn,
        customer: {
          name: sale.customer_name || 'Cash Customer',
          phone: sale.customer_phone || 'N/A',
          email: sale.customer_email || '',
          address: sale.customer_address || '',
          tin: sale.customer_tin || '',
          vrn: sale.customer_vrn || ''
        },
        invoiceSent: sale.invoice_sent,
        dueDate: sale.due_date,
        paymentReference: sale.payment_reference,
        verificationCode: sale.verification_code,
        notes: sale.notes,
        createdAt: sale.created_at,
        saleDate: sale.created_at,
        items: invoiceItems.map((item: any) => ({
          id: undefined,
          productId: item.productId,
          productName: item.productName,
          description: item.productName,
          quantity: item.quantity,
          unitPrice: parseFloat(item.unitPrice),
          buyingPrice: parseFloat(item.buyingPriceAtSale),
          profit: parseFloat(item.profit),
          discount: 0,
          totalPrice: parseFloat(item.totalPrice),
          total: parseFloat(item.totalPrice),
          unitType: item.unitType || ''
        })),
        profit: invoiceItems.reduce((sum, item) => sum + (Number(item.profit) || 0), 0),
        subtotal: subtotal,
        discount: 0,
        total: total,
        balanceDue: total
      };
    });
  }

  // Record a payment on an invoice
  async recordPayment(saleId: string, payment: { amount: number; paymentMethod: string; paymentReference?: string; notes?: string; recordedBy: string }, tenantId: string) {
    return db.transaction(async (client) => {
      // Get the sale
      const saleResult = await client.query(
        `SELECT s.*, sh.tenant_id FROM sales s JOIN shops sh ON s.shop_id = sh.id WHERE s.id = $1`,
        [saleId]
      );
      
      if (saleResult.rows.length === 0) {
        throw new Error('Invoice not found');
      }
      
      const sale = saleResult.rows[0];
      const totalAmount = parseFloat(sale.total_amount);
      const amountPaid = parseFloat(sale.amount_paid) || 0;
      const newPaymentAmount = payment.amount;
      const newTotalPaid = amountPaid + newPaymentAmount;
      
      if (newTotalPaid > totalAmount) {
        throw new Error(`Payment exceeds invoice total. Balance: TZS ${totalAmount - amountPaid}`);
      }
      
      // Record the payment
      await client.query(
        `INSERT INTO invoice_payments (sale_id, amount, payment_method, payment_reference, notes, recorded_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [saleId, newPaymentAmount, payment.paymentMethod, payment.paymentReference, payment.notes, payment.recordedBy]
      );
      
      // Update sale
      const newBalance = totalAmount - newTotalPaid;
      const newStatus = newBalance <= 0 ? 'paid' : newTotalPaid > 0 ? 'partial' : 'pending';
      
      const updatedResult = await client.query(
        `UPDATE sales SET amount_paid = $1, payment_status = $2, updated_at = NOW() WHERE id = $3 RETURNING *`,
        [newTotalPaid, newStatus, saleId]
      );
      
      // Update debtors status when fully paid
      if (newStatus === 'paid') {
        await client.query(
          `UPDATE debtors SET status = 'paid', paid_amount = total_amount WHERE sale_id = $1 AND status != 'paid'`,
          [saleId]
        );
        
        // Deduct stock for invoice sales when fully paid
        await client.query(
          `UPDATE products SET current_stock = current_stock - si.qty, updated_at = NOW()
           FROM (SELECT product_id, SUM(quantity) as qty FROM sale_items WHERE sale_id = $1 GROUP BY product_id) si
           WHERE products.id = si.product_id
           AND EXISTS (SELECT 1 FROM sales WHERE id = $1 AND sale_type = 'invoice')`,
          [saleId]
        );
      } else if (newStatus === 'partial') {
        await client.query(
          `UPDATE debtors SET status = 'partial', paid_amount = $1 WHERE sale_id = $2 AND status <> 'paid'`,
          [newTotalPaid, saleId]
        );
      }
      
      cache.invalidate(`sale:${saleId}`);
      cache.invalidateByPrefix('sale:');
      cache.invalidateByPrefix('stats:');
    cache.invalidateByPrefix('reports:');
      
      return {
        saleId,
        amountPaid: newPaymentAmount,
        totalPaid: newTotalPaid,
        balance: newBalance,
        status: newStatus,
        sale: updatedResult.rows[0]
      };
    });
  }

  // Get payment history for an invoice
  async getInvoicePayments(saleId: string, tenantId: string) {
    const saleResult = await db.read(
      `SELECT s.*, sh.tenant_id FROM sales s JOIN shops sh ON s.shop_id = sh.id WHERE s.id = $1`,
      [saleId]
    );
    
    if (saleResult.rows.length === 0) {
      throw new Error('Invoice not found');
    }
    
    const sale = saleResult.rows[0];
    const paymentsResult = await db.read(
      `SELECT ip.*, u.name as recorded_by_name, u.email as recorded_by_email
       FROM invoice_payments ip
       LEFT JOIN "user" u ON u.id = ip.recorded_by
       WHERE ip.sale_id = $1
       ORDER BY ip.created_at DESC`,
      [saleId]
    );
    
    return {
      saleId,
      totalAmount: parseFloat(sale.total_amount),
      amountPaid: parseFloat(sale.amount_paid) || 0,
      balance: parseFloat(sale.total_amount) - (parseFloat(sale.amount_paid) || 0),
      paymentStatus: sale.payment_status || 'pending',
      customerName: sale.customer_name,
      customerCompany: sale.customer_company,
      payments: paymentsResult.rows.map(p => ({
        id: p.id,
        amount: parseFloat(p.amount),
        paymentMethod: p.payment_method,
        paymentReference: p.payment_reference,
        notes: p.notes,
        recordedBy: p.recorded_by_name || p.recorded_by_email || 'Unknown',
        createdAt: p.created_at
      }))
    };
  }

  // Delete a sale (e.g. one sold by mistake). Callable by shop admins only —
  // the route/controller enforce that. Restores the product stock that was
  // deducted at sale time and removes every record tied to the sale (invoice
  // payments, debtors, stock-take flags) so no ghost totals remain in reports.
  async deleteInvoice(saleId: string, tenantId: string) {
    return db.transaction(async (client) => {
      const saleResult = await client.query(
        `SELECT s.*, sh.tenant_id FROM sales s JOIN shops sh ON s.shop_id = sh.id WHERE s.id = $1`,
        [saleId]
      );

      if (saleResult.rows.length === 0) {
        throw new Error('Sale not found');
      }

      const sale = saleResult.rows[0];

      // Tenant isolation - never let one tenant delete another tenant's sale.
      if (sale.tenant_id !== tenantId) {
        throw new Error('Sale not found');
      }

      // Restore stock the same way it was deducted in create(): SQM area,
      // unit conversions, custom shop units and fraction multipliers are all
      // recomputed from the stored sale item data.
      const itemsResult = await client.query(
        `SELECT si.product_id, si.quantity, si.fraction_type,
                si.unit_type AS sale_unit_type, si.dimension_l, si.dimension_w,
                p.unit_type AS product_unit_type, p.requires_dimensions,
                p.dimension_unit, p.unit_conversions
         FROM sale_items si
         LEFT JOIN products p ON p.id = si.product_id
         WHERE si.sale_id = $1`,
        [saleId]
      );
      const items = itemsResult.rows as any[];

      if (items.length > 0) {
        // Custom unit stock multipliers (shop_units) for non-standard units
        const customUnitCodes = [...new Set(
          items.map(i => i.sale_unit_type).filter((u): u is string => !!u)
        )];
        const customUnitsByCode = new Map<string, number>();
        if (customUnitCodes.length > 0) {
          try {
            const shopUnitsResult = await client.query(
              `SELECT code, stock_multiplier FROM shop_units
               WHERE shop_id = $1 AND code = ANY($2::text[]) AND is_active = true`,
              [sale.shop_id, customUnitCodes]
            );
            for (const unit of shopUnitsResult.rows as any[]) {
              customUnitsByCode.set(unit.code, parseFloat(unit.stock_multiplier));
            }
          } catch { /* shop_units may not exist in old databases */ }
        }

        const fractionMultipliers: Record<string, number> = {
          'whole': 1, 'half': 0.5, 'quarter': 0.25, 'third': 1/3, 'two_thirds': 2/3, 'custom': 1
        };

        const restoreByProduct = new Map<string, number>();
        for (const item of items) {
          if (!item.product_id) continue;
          const qty = parseFloat(item.quantity) || 0;
          if (qty <= 0) continue;

          const saleUnitType = item.sale_unit_type || item.product_unit_type || 'PCS';
          const productUnitType = item.product_unit_type || 'PCS';
          let deduction = qty;

          // Sold by dimensions (SQM)
          if (item.requires_dimensions || productUnitType === 'SQM') {
            const dimL = parseFloat(item.dimension_l) || 0;
            const dimW = parseFloat(item.dimension_w) || 0;
            const dimensionUnit = item.dimension_unit || 'm';
            const area = dimensionUnit === 'cm' ? (dimL * dimW) / 10000 : dimL * dimW;
            deduction = area * qty;
          } else if (saleUnitType !== productUnitType) {
            // Sold in a converted or custom unit
            let conversions: Record<string, any> = {};
            try {
              conversions = typeof item.unit_conversions === 'string'
                ? JSON.parse(item.unit_conversions) : (item.unit_conversions || {});
            } catch { conversions = {}; }
            if (conversions[saleUnitType]?.factor) {
              deduction = qty * parseFloat(conversions[saleUnitType].factor);
            } else if (customUnitsByCode.has(saleUnitType)) {
              deduction = qty * (customUnitsByCode.get(saleUnitType) || 1);
            }
          } else if (item.fraction_type && item.fraction_type !== 'whole') {
            // Fraction-based selling
            deduction = qty * (fractionMultipliers[item.fraction_type] || 1);
          }

          if (deduction > 0) {
            restoreByProduct.set(
              item.product_id,
              (restoreByProduct.get(item.product_id) || 0) + deduction
            );
          }
        }

        if (restoreByProduct.size > 0) {
          const entries = Array.from(restoreByProduct.entries());
          const stockValues = entries.flatMap(([productId, qty]) => [productId, qty]);
          const stockPlaceholders = entries.map((_, rowIndex) => {
            const start = rowIndex * 2 + 1;
            return `($${start}, $${start + 1})`;
          }).join(', ');
          await client.query(
            `UPDATE products AS p
             SET current_stock = p.current_stock + v.qty::numeric, updated_at = NOW()
             FROM (VALUES ${stockPlaceholders}) AS v(id, qty)
             WHERE p.id = v.id::uuid`,
            stockValues,
          );
        }
      }

      // Remove every record tied to the sale. debtors is deleted too so the
      // customer's ledger cannot keep a ghost debt after the sale disappears.
      await client.query('DELETE FROM sales_during_stock_take WHERE sale_id = $1', [saleId]).catch(() => {});
      await client.query('DELETE FROM debtors WHERE sale_id = $1', [saleId]);
      await client.query('DELETE FROM invoice_payments WHERE sale_id = $1', [saleId]);
      await client.query('DELETE FROM sale_items WHERE sale_id = $1', [saleId]);
      await client.query('DELETE FROM sales WHERE id = $1', [saleId]);

      cache.invalidate(`sale:${saleId}`);
      cache.invalidateByPrefix('sale:');
      cache.invalidateByPrefix('sales:list');
      cache.invalidateByPrefix('stats:');
    cache.invalidateByPrefix('reports:');

      return {
        deleted: true,
        saleId,
        shopId: sale.shop_id,
        totalAmount: parseFloat(sale.total_amount) || 0,
        itemCount: items.length
      };
    });
  }

  // Update payment status manually
  async updatePaymentStatus(saleId: string, status: string, tenantId: string, userId?: string) {
    const validStatuses = ['pending', 'partial', 'paid', 'cancelled'];
    if (!validStatuses.includes(status)) {
      throw new Error('Invalid payment status');
    }
    
    let result;
    if (status === 'paid') {
      // Get current sale to calculate payment amount
      const currentSale = await db.read('SELECT total_amount, amount_paid FROM sales WHERE id = $1', [saleId]);
      const prevAmountPaid = currentSale.rows.length > 0 ? parseFloat(currentSale.rows[0].amount_paid) || 0 : 0;
      const totalAmount = currentSale.rows.length > 0 ? parseFloat(currentSale.rows[0].total_amount) : 0;
      const paymentAmount = Math.max(0, totalAmount - prevAmountPaid);
      
      result = await db.write(
        `UPDATE sales SET payment_status = $1, amount_paid = total_amount, change_due = 0, updated_at = NOW() WHERE id = $2 RETURNING *`,
        [status, saleId]
      );
      
      // Record payment in invoice_payments for tracking
      if (paymentAmount > 0) {
        await db.write(
          `INSERT INTO invoice_payments (sale_id, amount, payment_method, notes, recorded_by)
           VALUES ($1, $2, 'cash', 'Marked as paid', $3)`,
          [saleId, paymentAmount, userId || 'system']
        );
      }
      // Update debtors status if exists
      await db.write(
        `UPDATE debtors SET status = 'paid', paid_amount = total_amount WHERE sale_id = $1 AND status != 'paid'`,
        [saleId]
      );
      
      // Deduct stock for invoice sales when marked as paid
      await db.write(
        `UPDATE products SET current_stock = current_stock - si.qty, updated_at = NOW()
         FROM (SELECT product_id, SUM(quantity) as qty FROM sale_items WHERE sale_id = $1 GROUP BY product_id) si
         WHERE products.id = si.product_id
         AND EXISTS (SELECT 1 FROM sales WHERE id = $1 AND sale_type = 'invoice')`,
        [saleId]
      );
    } else {
      result = await db.write(
        `UPDATE sales SET payment_status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
        [status, saleId]
      );
    }
    
    if (result.rows.length === 0) {
      throw new Error('Invoice not found');
    }
    
    cache.invalidate(`sale:${saleId}`);
    cache.invalidateByPrefix('stats:');
    cache.invalidateByPrefix('reports:');
    
    return {
      saleId,
      status: result.rows[0].payment_status,
      totalAmount: parseFloat(result.rows[0].total_amount),
      amountPaid: parseFloat(result.rows[0].amount_paid) || 0
    };
  }

  // Sales analytics overview
  async getSalesAnalytics(params: { tenantId: string; userRole: string; userShops: string[]; shopId?: string; startDate?: string; endDate?: string }) {
    const { tenantId, userRole, userShops, shopId, startDate, endDate } = params;
    
    let shopFilter = '';
    let shopParams: any[] = [];
    
    if (shopId) {
      shopFilter = 'AND s.shop_id = $1';
      shopParams = [shopId];
    } else if (userRole !== 'developer' && userShops.length > 0) {
      shopFilter = `AND s.shop_id = ANY($${shopParams.length + 1})`;
      shopParams.push(userShops);
    }
    
    // Shop-only params (no date filter) for daily/monthly queries
    const shopOnlyParams = [...shopParams];
    
    let dateFilter = '';
    if (startDate) {
      dateFilter += ` AND s.created_at >= $${shopParams.length + 1}`;
      shopParams.push(startDate);
    }
    if (endDate) {
      dateFilter += ` AND s.created_at < ($${shopParams.length + 1}::date + INTERVAL '1 day')`;
      shopParams.push(endDate);
    }
    
    // Overall stats
    const statsResult = await db.read(`
      SELECT 
        COUNT(*) as total_sales,
        COALESCE(SUM(s.total_amount), 0) as total_revenue,
        COALESCE(SUM(s.amount_paid), 0) as total_paid,
        COALESCE(SUM(s.total_amount - COALESCE(s.amount_paid, 0)), 0) as total_unpaid,
        COUNT(CASE WHEN s.payment_status = 'paid' THEN 1 END) as paid_count,
        COUNT(CASE WHEN s.payment_status = 'partial' THEN 1 END) as partial_count,
        COUNT(CASE WHEN s.payment_status = 'pending' THEN 1 END) as pending_count
      FROM sales s
      WHERE 1=1 ${shopFilter} ${dateFilter}
    `, shopParams);
    
    // Revenue by payment method
    const byMethodResult = await db.read(`
      SELECT s.payment_method, COUNT(*) as count, COALESCE(SUM(s.total_amount), 0) as total
      FROM sales s
      WHERE 1=1 ${shopFilter} ${dateFilter}
      GROUP BY s.payment_method
      ORDER BY total DESC
    `, shopParams);
    
    // Daily revenue (last 30 days)
    const dailyResult = await db.read(`
      SELECT DATE(s.created_at) as date, COUNT(*) as sales_count, COALESCE(SUM(s.total_amount), 0) as revenue
      FROM sales s
      WHERE s.created_at >= CURRENT_DATE - INTERVAL '30 days' ${shopFilter}
      GROUP BY DATE(s.created_at)
      ORDER BY date DESC
    `, shopOnlyParams);
    
    // Monthly revenue (last 12 months)
    const monthlyResult = await db.read(`
      SELECT DATE_TRUNC('month', s.created_at) as month, COUNT(*) as sales_count, COALESCE(SUM(s.total_amount), 0) as revenue
      FROM sales s
      WHERE s.created_at >= CURRENT_DATE - INTERVAL '12 months' ${shopFilter}
      GROUP BY DATE_TRUNC('month', s.created_at)
      ORDER BY month DESC
    `, shopOnlyParams);
    
    const stats = statsResult.rows[0];
    
    return {
      overview: {
        totalSales: parseInt(stats.total_sales),
        totalRevenue: parseFloat(stats.total_revenue),
        totalPaid: parseFloat(stats.total_paid),
        totalUnpaid: parseFloat(stats.total_unpaid),
        paidInvoices: parseInt(stats.paid_count),
        partialInvoices: parseInt(stats.partial_count),
        pendingInvoices: parseInt(stats.pending_count),
        collectionRate: parseFloat(stats.total_revenue) > 0 ? ((parseFloat(stats.total_paid) / parseFloat(stats.total_revenue)) * 100).toFixed(1) : '0'
      },
      byPaymentMethod: byMethodResult.rows.map(r => ({
        method: r.payment_method,
        count: parseInt(r.count),
        total: parseFloat(r.total)
      })),
      dailyRevenue: dailyResult.rows.map(r => ({
        date: r.date,
        salesCount: parseInt(r.sales_count),
        revenue: parseFloat(r.revenue)
      })),
      monthlyRevenue: monthlyResult.rows.map(r => ({
        month: r.month,
        salesCount: parseInt(r.sales_count),
        revenue: parseFloat(r.revenue)
      }))
    };
  }

  // Customer analytics
  async getCustomerAnalytics(params: { tenantId: string; userRole: string; userShops: string[]; shopId?: string; startDate?: string; endDate?: string }) {
    const { tenantId, userRole, userShops, shopId, startDate, endDate } = params;
    
    let shopFilter = '';
    let shopParams: any[] = [];
    
    if (shopId) {
      shopFilter = 'AND s.shop_id = $1';
      shopParams = [shopId];
    } else if (userRole !== 'developer' && userShops.length > 0) {
      shopFilter = `AND s.shop_id = ANY($${shopParams.length + 1})`;
      shopParams.push(userShops);
    }
    
    let dateFilter = '';
    if (startDate) {
      dateFilter += ` AND s.created_at >= $${shopParams.length + 1}`;
      shopParams.push(startDate);
    }
    if (endDate) {
      dateFilter += ` AND s.created_at < ($${shopParams.length + 1}::date + INTERVAL '1 day')`;
      shopParams.push(endDate);
    }
    
    // Top customers by revenue
    const topCustomersResult = await db.read(`
      SELECT 
        COALESCE(s.customer_company, s.customer_name, 'Walk-in Customer') as customer_name,
        s.customer_company,
        s.customer_name,
        s.customer_phone,
        s.customer_email,
        COUNT(*) as purchase_count,
        COALESCE(SUM(s.total_amount), 0) as total_spent,
        COALESCE(SUM(s.amount_paid), 0) as total_paid,
        COALESCE(SUM(s.total_amount - COALESCE(s.amount_paid, 0)), 0) as balance_due,
        MAX(s.created_at) as last_purchase
      FROM sales s
      WHERE (s.customer_name IS NOT NULL OR s.customer_company IS NOT NULL) ${shopFilter} ${dateFilter}
      GROUP BY s.customer_company, s.customer_name, s.customer_phone, s.customer_email
      ORDER BY total_spent DESC
      LIMIT 50
    `, shopParams);
    
    // Customers by frequency
    const frequencyResult = await db.read(`
      SELECT 
        COALESCE(s.customer_company, s.customer_name, 'Walk-in Customer') as customer_name,
        s.customer_company,
        s.customer_phone,
        COUNT(*) as purchase_count,
        COALESCE(SUM(s.total_amount), 0) as total_spent,
        MIN(s.created_at) as first_purchase,
        MAX(s.created_at) as last_purchase,
        EXTRACT(DAY FROM MAX(s.created_at) - MIN(s.created_at)) as days_active
      FROM sales s
      WHERE (s.customer_name IS NOT NULL OR s.customer_company IS NOT NULL) ${shopFilter} ${dateFilter}
      GROUP BY s.customer_company, s.customer_name, s.customer_phone
      HAVING COUNT(*) > 1
      ORDER BY purchase_count DESC
      LIMIT 30
    `, shopParams);
    
    // Bulk purchasers (single invoice > average)
    const bulkResult = await db.read(`
      SELECT 
        COALESCE(s.customer_company, s.customer_name, 'Walk-in Customer') as customer_name,
        s.customer_company,
        s.customer_name,
        s.customer_phone,
        s.total_amount,
        s.payment_status,
        s.created_at,
        (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) as item_count
      FROM sales s
      WHERE s.total_amount > (SELECT AVG(total_amount) FROM sales WHERE 1=1 ${shopFilter} ${dateFilter})
        AND (s.customer_name IS NOT NULL OR s.customer_company IS NOT NULL)
        ${shopFilter} ${dateFilter}
      ORDER BY s.total_amount DESC
      LIMIT 30
    `, shopParams);
    
    // Organization summary
    const orgResult = await db.read(`
      SELECT 
        s.customer_company as organization,
        COUNT(*) as total_orders,
        COALESCE(SUM(s.total_amount), 0) as total_spent,
        COALESCE(SUM(s.amount_paid), 0) as total_paid,
        COALESCE(SUM(s.total_amount - COALESCE(s.amount_paid, 0)), 0) as balance_due,
        COUNT(DISTINCT s.customer_name) as unique_contacts,
        MAX(s.created_at) as last_order
      FROM sales s
      WHERE s.customer_company IS NOT NULL ${shopFilter} ${dateFilter}
      GROUP BY s.customer_company
      ORDER BY total_spent DESC
      LIMIT 30
    `, shopParams);
    
    return {
      topCustomers: topCustomersResult.rows.map(r => ({
        name: r.customer_name,
        company: r.customer_company,
        phone: r.customer_phone,
        email: r.customer_email,
        purchaseCount: parseInt(r.purchase_count),
        totalSpent: parseFloat(r.total_spent),
        totalPaid: parseFloat(r.total_paid),
        balanceDue: parseFloat(r.balance_due),
        lastPurchase: r.last_purchase
      })),
      frequentCustomers: frequencyResult.rows.map(r => ({
        name: r.customer_name,
        company: r.customer_company,
        phone: r.customer_phone,
        purchaseCount: parseInt(r.purchase_count),
        totalSpent: parseFloat(r.total_spent),
        firstPurchase: r.first_purchase,
        lastPurchase: r.last_purchase,
        daysActive: parseFloat(r.days_active),
        avgPurchaseInterval: parseFloat(r.days_active) > 0 && parseInt(r.purchase_count) > 1 ? (parseFloat(r.days_active) / (parseInt(r.purchase_count) - 1)).toFixed(1) : null
      })),
      bulkPurchases: bulkResult.rows.map(r => ({
        name: r.customer_name,
        company: r.customer_company,
        phone: r.customer_phone,
        amount: parseFloat(r.total_amount),
        itemCount: parseInt(r.item_count),
        paymentStatus: r.payment_status,
        date: r.created_at
      })),
      organizations: orgResult.rows.map(r => ({
        name: r.organization,
        totalOrders: parseInt(r.total_orders),
        totalSpent: parseFloat(r.total_spent),
        totalPaid: parseFloat(r.total_paid),
        balanceDue: parseFloat(r.balance_due),
        uniqueContacts: parseInt(r.unique_contacts),
        lastOrder: r.last_order
      }))
    };
  }

    // Department (category) analytics — items sold & profit per department
  async getDepartmentAnalytics(params: { tenantId: string; userRole: string; userShops: string[]; shopId?: string; startDate?: string; endDate?: string }) {
    const { tenantId, userRole, userShops, shopId, startDate, endDate } = params;

    let shopFilter = '';
    let shopParams: any[] = [];

    if (shopId) {
      shopFilter = 'AND s.shop_id = $1';
      shopParams = [shopId];
    } else if (userRole !== 'developer' && userShops.length > 0) {
      shopFilter = `AND s.shop_id = ANY($${shopParams.length + 1})`;
      shopParams.push(userShops);
    }

    let dateFilter = '';
    if (startDate) {
      dateFilter += ` AND s.created_at >= $${shopParams.length + 1}`;
      shopParams.push(startDate);
    }
    if (endDate) {
      dateFilter += ` AND s.created_at < ($${shopParams.length + 1}::date + INTERVAL '1 day')`;
      shopParams.push(endDate);
    }

    const result = await db.read(`
      SELECT
        COALESCE(c.id, '00000000-0000-0000-0000-000000000000') as category_id,
        COALESCE(c.name, 'Uncategorized') as department,
        COALESCE(SUM(si.quantity), 0) as total_quantity,
        COALESCE(SUM(si.profit), 0) as total_profit,
        COALESCE(SUM(si.total_price), 0) as total_revenue,
        COUNT(DISTINCT si.sale_id) as transaction_count
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.id
      LEFT JOIN products p ON si.product_id = p.id
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE 1=1 ${shopFilter} ${dateFilter}
      GROUP BY c.id, c.name
      ORDER BY total_revenue DESC
    `, shopParams);

    return {
      departments: result.rows.map(r => ({
        departmentId: r.category_id,
        department: r.department,
        totalQuantity: parseFloat(r.total_quantity),
        totalProfit: parseFloat(r.total_profit),
        totalRevenue: parseFloat(r.total_revenue),
        transactionCount: parseInt(r.transaction_count),
        profitMargin: parseFloat(r.total_revenue) > 0 ? ((parseFloat(r.total_profit) / parseFloat(r.total_revenue)) * 100).toFixed(1) : '0'
      }))
    };
  }

  // Product analytics
  async getProductAnalytics(params: { tenantId: string; userRole: string; userShops: string[]; shopId?: string; startDate?: string; endDate?: string }) {
    const { tenantId, userRole, userShops, shopId, startDate, endDate } = params;
    
    let shopFilter = '';
    let shopParams: any[] = [];
    let prodShopFilter = '';
    let prodShopParams: any[] = [];
    
    if (shopId) {
      shopFilter = 'AND s.shop_id = $1';
      shopParams = [shopId];
      prodShopFilter = 'AND p.shop_id = $1';
      prodShopParams = [shopId];
    } else if (userRole !== 'developer' && userShops.length > 0) {
      shopFilter = `AND s.shop_id = ANY($${shopParams.length + 1})`;
      shopParams.push(userShops);
      prodShopFilter = 'AND p.shop_id = ANY($1)';
      prodShopParams = [userShops];
    }
    
    let dateFilter = '';
    if (startDate) {
      dateFilter += ` AND s.created_at >= $${shopParams.length + 1}`;
      shopParams.push(startDate);
    }
    if (endDate) {
      dateFilter += ` AND s.created_at < ($${shopParams.length + 1}::date + INTERVAL '1 day')`;
      shopParams.push(endDate);
    }
    
    // Top selling products
    const topProductsResult = await db.read(`
      SELECT 
        si.product_name,
        si.product_id,
        SUM(si.quantity) as total_quantity,
        COUNT(DISTINCT si.sale_id) as times_sold,
        COALESCE(SUM(si.total_price), 0) as total_revenue,
        COALESCE(SUM(si.profit), 0) as total_profit,
        AVG(si.unit_price) as avg_price
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.id
      WHERE 1=1 ${shopFilter} ${dateFilter}
      GROUP BY si.product_id, si.product_name
      ORDER BY total_revenue DESC
      LIMIT 50
    `, shopParams);
    
    // Low stock products (shop filter only, no date)
    const lowStockProductsResult = await db.read(`
      SELECT p.id, p.name, p.current_stock, p.low_stock_threshold, p.selling_price
      FROM products p
      WHERE 1=1 ${prodShopFilter}
      AND p.current_stock <= p.low_stock_threshold
      ORDER BY p.current_stock ASC
      LIMIT 30
    `, prodShopParams);
    
    return {
      topProducts: topProductsResult.rows.map(r => ({
        productId: r.product_id,
        name: r.product_name,
        totalQuantity: parseFloat(r.total_quantity),
        timesSold: parseInt(r.times_sold),
        totalRevenue: parseFloat(r.total_revenue),
        totalProfit: parseFloat(r.total_profit),
        avgPrice: parseFloat(r.avg_price),
        profitMargin: parseFloat(r.total_revenue) > 0 ? ((parseFloat(r.total_profit) / parseFloat(r.total_revenue)) * 100).toFixed(1) : '0'
      })),
      lowStockProducts: lowStockProductsResult.rows.map(r => ({
        id: r.id,
        name: r.name,
        currentStock: parseFloat(r.current_stock),
        lowStockThreshold: parseFloat(r.low_stock_threshold),
        sellingPrice: parseFloat(r.selling_price)
      }))
    };
  }
}

export const saleService = new SaleService();
