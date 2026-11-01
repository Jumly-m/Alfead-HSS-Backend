import cache from "../../utils/cache.js";
import type { z } from "zod";
import { db } from "../../config/database.js";
import { generateBarcode, generateSKU } from "../../utils/helpers.js";
import type { addCargoSchema, createProductSchema, productQuerySchema, updateProductSchema } from "./product.schema.js";

// TTL presets
const TTL = {
  SHORT: 30,
  MEDIUM: 300,
  LONG: 1800,
  HOUR: 3600,
};

type CreateProductInput = z.infer<typeof createProductSchema>;
type UpdateProductInput = z.infer<typeof updateProductSchema>;
type AddCargoInput = z.infer<typeof addCargoSchema>;
type ProductQueryInput = z.infer<typeof productQuerySchema>;

export class ProductService {
  // Find all products with caching
  async findAll(query: ProductQueryInput, tenantId: string, userShops: string[] = []) {
    const { 
      shopId, 
      search, 
      categoryId, 
      lowStock, 
      expiring,
      page = 1, 
      limit = 20,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = query;
    
    // Validate shopId format if provided
    const validShopId = shopId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(shopId) ? shopId : null;

    // Cache every page-1 query (search / low-stock / expiring / category too) so
    // repeat loads — POS product grid, dashboard low-stock widget, products page
    // search — resolve from memory instantly. All product mutations invalidate the
    // 'products:shop' prefix, so these keys stay fresh.
    const canCache = page === 1;
    const shopCacheKey = validShopId || `tenant:${tenantId}`;
    if (canCache) {
      const cacheKey = `products:shop:${shopCacheKey}:${limit}:${sortBy}:${sortOrder}:${search || ''}:${categoryId || ''}:${lowStock ? 'ls' : ''}:${expiring ? 'ex' : ''}`;
      const cached = cache.get<any>(cacheKey);
      if (cached) {
        return { ...cached, fromCache: true };
      }
    }
    
    const offset = (page - 1) * limit;
    
    let whereClause: string;
    let params: any[];
    let paramIndex: number;
    
    if (validShopId) {
      // User is requesting a specific shop - allow it
      whereClause = 'WHERE p.shop_id = $1 AND p.is_active = true';
      params = [validShopId];
      paramIndex = 2;
    } else if (userShops.length > 0) {
      whereClause = 'WHERE p.shop_id = ANY($1) AND p.is_active = true';
      params = [userShops];
      paramIndex = 2;
    } else {
      // No shops assigned - return empty
      return {
        products: [],
        pagination: {
          page: 1,
          limit: limit,
          total: 0,
          totalPages: 0
        },
        fromCache: false
      };
    }
    
    if (search) {
      whereClause += ` AND (p.name ILIKE $${paramIndex} OR p.sku ILIKE $${paramIndex} OR p.barcode ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }
    
    if (categoryId) {
      if (categoryId === 'none') {
        whereClause += ` AND p.category_id IS NULL`;
      } else {
        whereClause += ` AND p.category_id = $${paramIndex}`;
        params.push(categoryId);
        paramIndex++;
      }
    }
    
    if (lowStock) {
      whereClause += ` AND p.current_stock <= p.low_stock_threshold`;
    }
    
    if (expiring) {
      // Products that still have stock and expire within 30 days (already
      // expired ones included — they are the most urgent to clear).
      whereClause += ` AND p.expiry_date IS NOT NULL AND p.current_stock > 0 AND p.expiry_date <= CURRENT_DATE + INTERVAL '30 days'`;
    }
    
    // Whitelisted sort column + direction only — never interpolate raw request
    // values into SQL (ORDER BY accepts subqueries, so this must be strict).
    const sortColumn = {
      name: 'p.name',
      createdAt: 'p.created_at',
      stock: 'p.current_stock',
      price: 'p.selling_price'
    }[sortBy] || 'p.name';
    const sortDirection = String(sortOrder || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    
    const result = await db.read(
      `SELECT p.*, c.name as category_name, c.color as category_color,
              COUNT(*) OVER() as total_count
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       ${whereClause}
       ORDER BY ${expiring ? 'p.expiry_date ASC' : `${sortColumn} ${sortDirection}`}
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset]
    );
    const total = result.rows.length > 0
      ? parseInt(result.rows[0].total_count)
      : parseInt((await db.read(`SELECT COUNT(*) FROM products p ${whereClause}`, params)).rows[0].count);
    
    const response = {
      products: result.rows.map(this.formatProduct),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      },
      fromCache: false
    };
    
    // Cache page-1 queries for instant repeat loads
    if (canCache) {
      const cacheKey = `products:shop:${shopCacheKey}:${limit}:${sortBy}:${sortOrder}:${search || ''}:${categoryId || ''}:${lowStock ? 'ls' : ''}:${expiring ? 'ex' : ''}`;
      cache.set(cacheKey, response, TTL.SHORT);
    }
    
    return response;
  }
  
  // Find by ID with caching
  async findById(id: string, tenantId: string) {
    const cacheKey = `product:${id}`;
    
    return cache.getOrSet(cacheKey, async () => {
      const result = await db.read(
        `SELECT p.*, c.name as category_name, c.color as category_color
         FROM products p
         LEFT JOIN categories c ON p.category_id = c.id
         WHERE p.id = $1`,
        [id]
      );
      
      if (result.rows.length === 0) {
        throw new Error('Product not found');
      }
      
      const product = this.formatProduct(result.rows[0]);
      
      // Get cargo history
      const cargoResult = await db.read(
        `SELECT ce.*, u.first_name, u.last_name
         FROM cargo_entries ce
         JOIN "user" u ON ce.created_by = u.id
         WHERE ce.product_id = $1
         ORDER BY ce.created_at DESC`,
        [id]
      );
      
      return {
        ...product,
        cargoHistory: cargoResult.rows.map((row: any) => ({
          id: row.id,
          quantity: row.quantity,
          buyingPricePerUnit: row.buying_price_per_unit,
          supplierName: row.supplier_name,
          supplierContact: row.supplier_contact,
          notes: row.notes,
          entryDate: row.created_at,
        }))
      };
    }, TTL.MEDIUM);
  }
  
  // Find by barcode (for POS - always fresh data)
  async findByBarcode(barcode: string, shopId: string) {
    const result = await db.read(
      `SELECT p.*, c.name as category_name
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.barcode = $1 AND p.shop_id = $2 AND p.is_active = true`,
      [barcode, shopId]
    );
    
    if (result.rows.length === 0) {
      throw new Error('Product not found');
    }
    
    return this.formatProduct(result.rows[0]);
  }

  // Incremental product sync for the POS local index. Returns only rows that
  // changed after the caller's cursor, oldest first, so a phone can keep a
  // complete product snapshot without re-downloading the catalogue. Uses a
  // (updated_at, id) keyset so a full page never skips rows that share a
  // timestamp. Inactive rows are included so the client can hide them.
  async getChangesSince(shopId: string, since: string, afterId: string, limit = 500) {
    const sinceDate = Number.isFinite(Date.parse(String(since))) ? new Date(since) : new Date(0);
    const after = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(afterId || ''))
      ? afterId
      : '00000000-0000-0000-0000-000000000000';
    const safeLimit = Math.min(Math.max(Number.parseInt(String(limit), 10) || 500, 1), 1000);

    const result = await db.read(
      `SELECT p.*, c.name as category_name, c.color as category_color,
              COALESCE(p.updated_at, p.created_at) as sync_ts
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.shop_id = $1
         AND (COALESCE(p.updated_at, p.created_at) > $2
              OR (COALESCE(p.updated_at, p.created_at) = $2 AND p.id > $3::uuid))
       ORDER BY COALESCE(p.updated_at, p.created_at) ASC, p.id ASC
       LIMIT $4`,
      [shopId, sinceDate, after, safeLimit]
    );

    const products = result.rows.map(this.formatProduct);
    const last = result.rows[result.rows.length - 1];

    return {
      products,
      hasMore: result.rows.length === safeLimit,
      // Keyset cursor for the next call. Always derived from the last returned
      // row so rows updated while a page was being sent are never skipped; an
      // empty page simply keeps the caller's existing cursor.
      nextSince: last ? new Date(last.sync_ts).toISOString() : sinceDate.toISOString(),
      nextId: last ? last.id : after,
      serverTime: new Date().toISOString(),
    };
  }
  
  // Create product with immediate cache update
  async create(data: CreateProductInput, userId: string) {
    const {
      id: clientId,
      shopId,
      name,
      description,
      sku,
      categoryId,
      buyingPrice,
      sellingPrice,
      initialStock,
      lowStockThreshold,
      expiryDate,
      images,
      generateBarcode,
      enableFractions,
      fractionTypes,
      fractionPrices,
      unitType,
      requiresDimensions,
      unitConversions,
      costPerQty,
      costPerQtyPrice,
      costPerQtyBuyPrice
    } = data;
    
    const productSku = sku || await this.generateUniqueSku(shopId);
    const barcode = generateBarcode ? this.generateBarcodeValue() : null;
    const qrCode = generateBarcode ? this.generateBarcodeValue() : null;
    
    const createdByUuid = userId || null;
    
    // Convert images array to PostgreSQL format or null
    const imagesArray = Array.isArray(images) && images.length > 0 ? images : null;
    
    // Convert fractionTypes to PostgreSQL array format
    const fractionTypesArray = Array.isArray(fractionTypes) && fractionTypes.length > 0 
      ? `{${fractionTypes.join(',')}}` 
      : null;
    
    return db.transaction(async (client) => {
      // Idempotent replay: an offline-created product carries its client id. If
      // it already exists (first attempt committed but the response was lost),
      // return the existing row instead of creating a duplicate.
      if (clientId) {
        const existing = await client.query(`SELECT * FROM products WHERE id = $1`, [clientId]);
        if (existing.rows.length > 0) {
          return { ...this.formatProduct(existing.rows[0]), _duplicate: true };
        }
      }

      // Create product (write pool)
      const productResult = await client.query(
         `INSERT INTO products (id, shop_id, category_id, name, description, sku, barcode, qr_code, 
          buying_price, selling_price, current_stock, low_stock_threshold, expiry_date, images, created_by,
          enable_fractions, fraction_types, fraction_prices, unit_type, requires_dimensions, dimension_unit, unit_conversions,
          full_product_length, full_product_width, full_product_price,
          cost_per_qty, cost_per_qty_price, cost_per_qty_buy_price)
          VALUES (COALESCE($1::uuid, uuid_generate_v4()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28)
          RETURNING *`,
        [clientId || null, shopId, categoryId || null, name, description || null, productSku, barcode, qrCode,
         buyingPrice, sellingPrice, initialStock, lowStockThreshold, expiryDate || null, imagesArray, createdByUuid,
         enableFractions || false, fractionTypesArray, JSON.stringify(fractionPrices || {}),
         unitType || 'PCS', requiresDimensions || false, (data as any).dimensionUnit || 'm', JSON.stringify(unitConversions || {}),
         (data as any).fullProductLength || null, (data as any).fullProductWidth || null, (data as any).fullProductPrice || null,
         costPerQty || 1, costPerQtyPrice || 0, costPerQtyBuyPrice || 0]
      );
      
      const product = productResult.rows[0];
      
      // Create cargo entry for initial stock
      if (initialStock > 0) {
        await client.query(
          `INSERT INTO cargo_entries (product_id, quantity, buying_price_per_unit, created_by, notes)
           VALUES ($1, $2, $3, $4, $5)`,
          [product.id, initialStock, buyingPrice, createdByUuid, 'Initial stock']
        );
      }
      
      const formatted = this.formatProduct(product);
      
      // Cache the new product
      cache.set(`product:${product.id}`, formatted, TTL.MEDIUM);
      
      // Invalidate shop products cache
      cache.invalidateByPrefix('products:shop');
      cache.invalidateByPrefix('stats:');
      
      return formatted;
    });
  }
  
  // Update product with immediate cache update
  async update(id: string, data: UpdateProductInput, tenantId: string) {
    const setClause: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;
    
    if (data.name) {
      setClause.push(`name = $${paramIndex}`);
      values.push(data.name);
      paramIndex++;
    }
    
    if (data.description !== undefined) {
      setClause.push(`description = $${paramIndex}`);
      values.push(data.description);
      paramIndex++;
    }
    
    if (data.categoryId !== undefined) {
      setClause.push(`category_id = $${paramIndex}`);
      values.push(data.categoryId);
      paramIndex++;
    }
    
    if (data.sellingPrice !== undefined) {
      setClause.push(`selling_price = $${paramIndex}`);
      values.push(data.sellingPrice);
      paramIndex++;
    }
    
    if (data.lowStockThreshold !== undefined) {
      setClause.push(`low_stock_threshold = $${paramIndex}`);
      values.push(data.lowStockThreshold);
      paramIndex++;
    }
    
    if (data.expiryDate !== undefined) {
      setClause.push(`expiry_date = $${paramIndex}`);
      values.push(data.expiryDate);
      paramIndex++;
    }
    
    if (data.images !== undefined) {
      setClause.push(`images = $${paramIndex}`);
      values.push(Array.isArray(data.images) && data.images.length > 0 ? data.images : null);
      paramIndex++;
    }
    
    if (data.isActive !== undefined) {
      setClause.push(`is_active = $${paramIndex}`);
      values.push(data.isActive);
      paramIndex++;
    }

    if (data.currentStock !== undefined) {
      setClause.push(`current_stock = $${paramIndex}`);
      values.push(data.currentStock);
      paramIndex++;
    }

    if (data.buyingPrice !== undefined) {
      setClause.push(`buying_price = $${paramIndex}`);
      values.push(data.buyingPrice);
      paramIndex++;
    }

    if (data.enableFractions !== undefined) {
      setClause.push(`enable_fractions = $${paramIndex}`);
      values.push(data.enableFractions);
      paramIndex++;
    }

    if (data.fractionTypes !== undefined) {
      setClause.push(`fraction_types = $${paramIndex}`);
      const ft = Array.isArray(data.fractionTypes) && data.fractionTypes.length > 0 
        ? `{${data.fractionTypes.join(',')}}` 
        : null;
      values.push(ft);
      paramIndex++;
    }

    if (data.fractionPrices !== undefined) {
      setClause.push(`fraction_prices = $${paramIndex}`);
      values.push(JSON.stringify(data.fractionPrices));
      paramIndex++;
    }

    if (data.unitType !== undefined) {
      setClause.push(`unit_type = $${paramIndex}`);
      values.push(data.unitType);
      paramIndex++;
    }

    if (data.requiresDimensions !== undefined) {
      setClause.push(`requires_dimensions = $${paramIndex}`);
      values.push(data.requiresDimensions);
      paramIndex++;
    }

    if ((data as any).dimensionUnit !== undefined) {
      setClause.push(`dimension_unit = $${paramIndex}`);
      values.push((data as any).dimensionUnit);
      paramIndex++;
    }

    if (data.unitConversions !== undefined) {
      setClause.push(`unit_conversions = $${paramIndex}`);
      values.push(JSON.stringify(data.unitConversions));
      paramIndex++;
    }

    if ((data as any).fullProductLength !== undefined) {
      setClause.push(`full_product_length = $${paramIndex}`);
      values.push((data as any).fullProductLength);
      paramIndex++;
    }

    if ((data as any).fullProductWidth !== undefined) {
      setClause.push(`full_product_width = $${paramIndex}`);
      values.push((data as any).fullProductWidth);
      paramIndex++;
    }

    if ((data as any).fullProductPrice !== undefined) {
      setClause.push(`full_product_price = $${paramIndex}`);
      values.push((data as any).fullProductPrice);
      paramIndex++;
    }

    if (data.costPerQty !== undefined) {
      setClause.push(`cost_per_qty = $${paramIndex}`);
      values.push(data.costPerQty);
      paramIndex++;
    }

    if (data.costPerQtyPrice !== undefined) {
      setClause.push(`cost_per_qty_price = $${paramIndex}`);
      values.push(data.costPerQtyPrice);
      paramIndex++;
    }

    if (data.costPerQtyBuyPrice !== undefined) {
      setClause.push(`cost_per_qty_buy_price = $${paramIndex}`);
      values.push(data.costPerQtyBuyPrice);
      paramIndex++;
    }

    if (setClause.length === 0) {
      throw new Error('No fields to update');
    }
    
    values.push(id);
    
    // Use write pool
    const result = await db.write(
      `UPDATE products SET ${setClause.join(', ')}, updated_at = NOW() WHERE id = $${paramIndex} RETURNING *`,
      values
    );
    
    if (result.rows.length === 0) {
      throw new Error('Product not found');
    }
    
    const formatted = this.formatProduct(result.rows[0]);
    
    // Update cache immediately
    cache.set(`product:${id}`, formatted, TTL.MEDIUM);
    
    cache.invalidateByPrefix('products:shop');
    cache.invalidateByPrefix('stats:');
    cache.invalidate(`product:${id}`);
    
    return formatted;
  }
  
  // Add cargo with immediate stock update
  async addCargo(productId: string, data: AddCargoInput, userId: string) {
    const { quantity, buyingPricePerUnit, supplierName, supplierContact, notes, transportCost } = data;
    
    return db.transaction(async (client) => {
      // Create cargo entry
      const cargoResult = await client.query(
        `INSERT INTO cargo_entries (product_id, quantity, buying_price_per_unit, transport_cost, supplier_name, supplier_contact, created_by, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [productId, quantity, buyingPricePerUnit, transportCost || 0, supplierName || null, supplierContact || null, userId, notes || null]
      );
      
      const cargo = cargoResult.rows[0];
      
      // Update product stock
      const productResult = await client.query(
        `UPDATE products SET current_stock = current_stock + $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
        [quantity, productId]
      );
      
      const product = this.formatProduct(productResult.rows[0]);
      
      // Update cache
      cache.set(`product:${productId}`, product, TTL.MEDIUM);
      cache.invalidateByPrefix('products:shop');
      cache.invalidateByPrefix('stats:');
      
      return {
        cargo: {
          id: cargo.id,
          quantity: cargo.quantity,
          buyingPricePerUnit: cargo.buying_price_per_unit,
          transportCost: cargo.transport_cost,
          supplierName: cargo.supplier_name,
          supplierContact: cargo.supplier_contact,
          notes: cargo.notes,
          entryDate: cargo.entry_date
        },
        product
      };
    });
  }
  
  private async generateUniqueSku(shopId: string): Promise<string> {
    const result = await db.read(
      'SELECT COUNT(*) FROM products WHERE shop_id = $1',
      [shopId]
    );
    
    const count = parseInt(result.rows[0].count) + 1;
    return generateSKU(shopId, count);
  }
  
  private generateBarcodeValue(): string {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `DUKA-${timestamp}${random}`;
  }

  // Numbers arriving from spreadsheets may be real Excel numbers, "50,000",
  // "TSh 50,000.00" or "2,5" (decimal comma) — normalize all of them.
  private importNumber(value: any): number | null {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    let s = String(value).trim();
    if (!s) return null;
    s = s.replace(/(tsh|tzs|ksh|usd|shs|sh)\b/gi, '').replace(/[^\d.,-]/g, '');
    if (!s || s === '-' || s === '.' || s === ',') return null;
    if (s.includes(',')) {
      if (s.includes('.')) {
        s = s.replace(/,/g, '');
      } else {
        const parts = s.split(',');
        // 1,234,567 → thousands separators; 2,5 → decimal comma.
        if (parts.length > 2 || parts.slice(1).every((p) => p.length === 3)) s = s.replace(/,/g, '');
        else s = s.replace(',', '.');
      }
    }
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  }

  // Unit labels from the printed/exported list ("m²", "pcs", …) → internal
  // codes; custom unit codes pass through unchanged.
  private normalizeUnitType(value: any): string {
    const raw = String(value ?? '').trim();
    if (!raw) return 'PCS';
    const key = raw.toLowerCase().replace(/\s+/g, ' ');
    const map: Record<string, string> = {
      'm²': 'SQM', 'm2': 'SQM', 'm^2': 'SQM', 'sqm': 'SQM', 'square meter': 'SQM',
      'square meters': 'SQM', 'square metre': 'SQM', 'mita za mraba': 'SQM',
      'm': 'MTR', 'mtr': 'MTR', 'meter': 'MTR', 'meters': 'MTR', 'metre': 'MTR',
      'mita': 'MTR',
      'ton': 'TON', 'tons': 'TON', 'tonne': 'TON', 'tani': 'TON',
      'kg': 'KG', 'kgs': 'KG', 'kilo': 'KG', 'kilos': 'KG', 'kilogram': 'KG',
      'pcs': 'PCS', 'pc': 'PCS', 'piece': 'PCS', 'pieces': 'PCS', 'kipande': 'PCS',
      'vipande': 'PCS',
      'roll': 'ROLL', 'rolls': 'ROLL', 'roli': 'ROLL',
      'yd': 'YRD', 'yrd': 'YRD', 'yard': 'YRD', 'yards': 'YRD',
      'ft': 'FT', 'futi': 'FT', 'feet': 'FT',
      'pkg': 'PKG', 'package': 'PKG', 'packages': 'PKG',
      'bnd': 'BND', 'bundle': 'BND', 'bundles': 'BND',
      'box': 'BOX', 'boxes': 'BOX', 'boksi': 'BOX',
      'set': 'SET', 'sets': 'SET',
      'ltr': 'LTR', 'l': 'LTR', 'liter': 'LTR', 'liters': 'LTR', 'litre': 'LTR',
      'litres': 'LTR', 'lita': 'LTR',
    };
    if (map[key]) return map[key];
    const upper = raw.toUpperCase();
    if (upper.length <= 20 && /^[A-Z0-9_-]+$/.test(upper)) return upper;
    return 'PCS';
  }
  
  private formatProduct(row: any) {
    let fractionTypes = [];
    let fractionPrices = {};
    let unitConversions = {};
    
    try {
      fractionTypes = typeof row.fraction_types === 'string' ? JSON.parse(row.fraction_types) : (row.fraction_types || []);
    } catch { fractionTypes = []; }
    
    try {
      fractionPrices = typeof row.fraction_prices === 'string' ? JSON.parse(row.fraction_prices) : (row.fraction_prices || {});
    } catch { fractionPrices = {}; }

    try {
      unitConversions = typeof row.unit_conversions === 'string' ? JSON.parse(row.unit_conversions) : (row.unit_conversions || {});
    } catch { unitConversions = {}; }
    
    return {
      id: row.id,
      shopId: row.shop_id,
      name: row.name,
      description: row.description,
      sku: row.sku,
      barcode: row.barcode,
      qrCode: row.qr_code,
      buyingPrice: parseFloat(row.buying_price),
      sellingPrice: row.selling_price ? parseFloat(row.selling_price) : null,
      currentStock: parseFloat(row.current_stock),
      lowStockThreshold: parseFloat(row.low_stock_threshold),
      expiryDate: row.expiry_date,
      images: row.images || [],
      isActive: row.is_active,
      enableFractions: row.enable_fractions || false,
      fractionTypes,
      fractionPrices,
      unitType: row.unit_type || 'PCS',
      requiresDimensions: row.requires_dimensions || false,
      dimensionUnit: row.dimension_unit || 'm',
      fullSheetLength: row.full_product_length ? parseFloat(row.full_product_length) : null,
      fullSheetWidth: row.full_product_width ? parseFloat(row.full_product_width) : null,
      fullSheetPrice: row.full_product_price ? parseFloat(row.full_product_price) : null,
      costPerQty: parseFloat(row.cost_per_qty) || 1,
      costPerQtyPrice: parseFloat(row.cost_per_qty_price) || 0,
      costPerQtyBuyPrice: parseFloat(row.cost_per_qty_buy_price) || 0,
      unitConversions,
      category: row.category_id ? {
        id: row.category_id,
        name: row.category_name,
        color: row.category_color
      } : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  // Bulk import with transaction and cache invalidation.
  // Accepts the layout the Products page exports (PDF/Excel):
  //   name, categoryName, unitType (code or label), buyingPrice,
  //   sellingPrice, initialStock, lowStockThreshold, barcode (optional).
  // A supplied barcode is kept as-is so labels already printed and scanner
  // lookups keep working; a blank cell gets a generated one. A barcode that
  // already belongs to another product in the shop makes the row SKIPPED
  // (warned, never failed, never overwritten). Missing categories are created
  // so imported goods keep grouping.
  async importProducts(shopId: string, products: any[], userId: string) {
    const errors: { row: number; message: string }[] = [];
    const warnings: { row: number; message: string }[] = [];
    let successCount = 0;
    let skippedCount = 0;
    const createdIds: string[] = [];

    await db.transaction(async (client) => {
      // Existing categories for this shop, matched by lowercase name.
      const categoryIds = new Map<string, string>();
      const existingCategories = await client.query(
        `SELECT id, name FROM categories WHERE shop_id = $1`,
        [shopId]
      );
      for (const row of existingCategories.rows) {
        categoryIds.set(String(row.name).trim().toLowerCase(), row.id);
      }

      // Barcodes already used in this shop, plus the ones used by earlier rows
      // of the same file. Loaded once so the per-row check is free and, more
      // importantly, so a clash is decided BEFORE the INSERT — a failed INSERT
      // would abort the whole transaction on Postgres.
      const usedBarcodes = new Set<string>();
      const existingBarcodes = await client.query(
        `SELECT barcode FROM products WHERE shop_id = $1 AND barcode IS NOT NULL AND barcode <> ''`,
        [shopId]
      );
      for (const row of existingBarcodes.rows) usedBarcodes.add(String(row.barcode));

      for (let i = 0; i < products.length; i++) {
        const product = products[i] || {};
        const row = i + 2; // spreadsheet row (header is row 1)

        const name = String(product.name ?? '').trim();
        if (!name) {
          errors.push({ row, message: 'Missing product name' });
          continue;
        }

        const sellingPrice = this.importNumber(product.sellingPrice);
        if (sellingPrice === null) {
          errors.push({ row, message: `Missing required field: selling price (${name})` });
          continue;
        }
        const buyingPrice = this.importNumber(product.buyingPrice) ?? 0;
        const initialStock = this.importNumber(product.initialStock) ?? 0;
        const lowStockThreshold = this.importNumber(product.lowStockThreshold) ?? 10;

        // Category: assign to the existing category with the same name, or
        // create it so imported goods keep their grouping.
        let categoryId: string | null = null;
        const categoryName = String(product.categoryName ?? product.category ?? '').trim();
        if (categoryName) {
          const key = categoryName.toLowerCase();
          categoryId = categoryIds.get(key) || null;
          if (!categoryId) {
            const created = await client.query(
              `INSERT INTO categories (shop_id, name) VALUES ($1, $2) RETURNING id`,
              [shopId, categoryName.slice(0, 100)]
            );
            const newCategoryId = created.rows[0].id as string;
            categoryId = newCategoryId;
            categoryIds.set(key, newCategoryId);
          }
        }

        // Barcode: the file may carry the shop's real codes (labels already
        // printed, scanner lookups). Keep them. A row whose barcode already
        // belongs to a product in this shop is skipped and reported — it is
        // never failed, and the existing product is never overwritten.
        const suppliedBarcode = String(product.barcode ?? '').trim().slice(0, 100);
        if (suppliedBarcode && usedBarcodes.has(suppliedBarcode)) {
          warnings.push({
            row,
            message: `Barcode already exists, row skipped — ${name} (${suppliedBarcode})`,
          });
          skippedCount++;
          continue;
        }
        let barcode = suppliedBarcode || this.generateBarcodeValue();
        // Generated values are timestamp+random; the loop guards the (unlikely)
        // collision instead of letting the unique index reject the row.
        while (usedBarcodes.has(barcode)) barcode = this.generateBarcodeValue();
        usedBarcodes.add(barcode);

        // One savepoint per row: if this row fails, only this row is rolled
        // back. Without it a single bad row would abort the transaction and
        // every remaining row would fail with "current transaction is aborted".
        await client.query('SAVEPOINT import_row');
        try {
          const sku = String(product.sku ?? '').trim().slice(0, 100)
            || `SKU-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
          const unitType = this.normalizeUnitType(product.unitType);

          const result = await client.query(
            `INSERT INTO products (shop_id, category_id, name, sku, barcode, buying_price, selling_price, current_stock, low_stock_threshold, unit_type, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true)
             RETURNING id`,
            [shopId, categoryId, name.slice(0, 255), sku, barcode, buyingPrice, sellingPrice, initialStock, lowStockThreshold, unitType]
          );

          // Cargo entry for opening stock, same as a manually created product.
          if (initialStock > 0) {
            await client.query(
              `INSERT INTO cargo_entries (product_id, quantity, buying_price_per_unit, created_by, notes)
               VALUES ($1, $2, $3, $4, $5)`,
              [result.rows[0].id, initialStock, buyingPrice, userId || null, 'Initial stock (import)']
            );
          }

          await client.query('RELEASE SAVEPOINT import_row');
          createdIds.push(result.rows[0].id);
          successCount++;
        } catch (err: any) {
          await client.query('ROLLBACK TO SAVEPOINT import_row');
          // 23505 = unique_violation (shop_barcode_idx): a concurrent import
          // took the barcode between the check above and the INSERT. Report it
          // the same way the pre-check would, instead of a hard failure.
          if (err?.code === '23505') {
            warnings.push({ row, message: `Barcode already exists, row skipped — ${name} (${barcode})` });
            skippedCount++;
          } else {
            errors.push({ row, message: err.message });
          }
        }
      }
    });

    // Invalidate products cache
    cache.invalidateByPrefix('products:shop');
    cache.invalidateByPrefix('stats:');

    return {
      successCount,
      failedCount: errors.length,
      errors,
      skippedCount,
      warnings,
    };
  }

  async hardDelete(id: string): Promise<boolean> {
    try {
      await db.write('DELETE FROM products WHERE id = $1', [id]);
      cache.invalidate(`product:${id}`);
      cache.invalidateByPrefix('products:shop');
      cache.invalidateByPrefix('stats:');
      return true;
    } catch (e) {
      const error = e as Error;
      if (error.message.includes('foreign key constraint') || error.message.includes('violates')) {
        return false;
      }
      throw error;
    }
  }

  async bulkDelete(productIds: string[]) {
    let deletedCount = 0;
    let skippedCount = 0;
    const skippedProducts: string[] = [];
    
    for (const productId of productIds) {
      try {
        await db.write('DELETE FROM products WHERE id = $1', [productId]);
        cache.invalidate(`product:${productId}`);
        deletedCount++;
      } catch (e) {
        const error = e as Error;
        if (error.message.includes('foreign key constraint') || error.message.includes('violates')) {
          skippedCount++;
          skippedProducts.push(productId);
        } else {
          console.error('Error deleting product:', productId, error.message);
        }
      }
    }
    
    cache.invalidateByPrefix('products:shop');
    cache.invalidateByPrefix('stats:');
    
    return { 
      deletedCount, 
      skippedCount,
      skippedProducts,
      message: skippedCount > 0 
        ? `${skippedCount} product(s) could not be deleted because they have associated sales`
        : undefined 
    };
  }
}

export const productService = new ProductService();
