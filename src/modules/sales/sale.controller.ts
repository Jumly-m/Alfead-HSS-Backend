import { saleService } from './sale.service.js';
import { pool } from '../../config/drizzle.js';
import { logActivity } from '../../utils/activity-logger.js';
import { handleAutoSmsOnSale, handleAdminSaleSmsOnSale } from '../../services/sms-reseller.service.js';
import { hasPermission } from '../../middleware/rbac.middleware.js';
import cache from '../../utils/cache.js';
import type { Context } from 'hono';

// Remove profit figures when the caller may not view them.
function scrubProfit(result: any) {
  if (Array.isArray(result?.sales)) {
    for (const s of result.sales) delete s.profit;
  }
  if (result?.summary && typeof result.summary === 'object') {
    delete result.summary.totalProfit;
  }
}

export class SaleController {
  async getAll(c: Context) {
    try {
      const query = c.get('validatedQuery');
      const tenantId = c.get('tenantId');
      const userRole = c.get('userRole');
      const userShops = c.get('shopIds');
      
      // Cache small, unfiltered list requests (e.g. the dashboard's recent-sales
      // widget) so repeat loads don't re-hit the DB. Mutations below invalidate
      // the 'sales:list' prefix, keeping the short TTL safe.
      const limit = Number(query.limit) || 20;
      const simple = limit <= 20 && !query.dateFrom && !query.dateTo &&
        !query.paymentMethod && !query.search && !query.saleType;
      let result;
      if (simple) {
        const cacheKey = `sales:list:${tenantId}:${[...userShops].sort().join(',')}:${JSON.stringify(query)}`;
        const cached = cache.get<any>(cacheKey);
        if (cached) {
          result = cached;
        } else {
          result = await saleService.findAll(query, tenantId, userRole, userShops);
          cache.set(cacheKey, result, 3);
        }
      } else {
        result = await saleService.findAll(query, tenantId, userRole, userShops);
      }

      // Sellers without sale:profit never receive profit figures.
      if (userRole === 'seller') {
        const userId = c.get('userId');
        const shopId = (userShops || [])[0] as string;
        const canProfit = await hasPermission(userId, userRole, shopId, 'sale:profit');
        if (!canProfit) scrubProfit(result);
      }
      
      return c.json({
        success: true,
        data: result
      });
    } catch (error: any) {
      console.error('[SaleController] Error:', error);
      const status = error.message === 'Access denied to this shop' ? 403 : 400;
      return c.json({
        success: false,
        error: error.message
      }, status);
    }
  }
  
  async getById(c: Context) {
    try {
      const id = c.req.param('id') as string;
      const tenantId = c.get('tenantId');
      
      // Validate UUID format
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(id)) {
        return c.json({ success: false, error: 'Invalid sale ID format' }, 400);
      }
      
      const sale = await saleService.findById(id, tenantId);
      
      return c.json({
        success: true,
        data: { sale }
      });
    } catch (error: any) {
      if (error.message === 'Sale not found') {
        return c.json({
          success: false,
          error: 'Sale not found'
        }, 404);
      }
      throw error;
    }
  }
  
  async create(c: Context) {
    try {
      const data = c.get('validatedBody');
      const sellerId = c.get('userId');
      const user = c.get('user') as any;
      const shopId = data.shopId;
      
      // Check if there's an active stock take session for this shop
      let stockTakeWarning = null;
      try {
        const stockTakeResult = await pool.query(
          `SELECT id, name FROM stock_take_sessions 
           WHERE shop_id = $1 AND status = 'in_progress' LIMIT 1`,
          [shopId]
        );
        if (stockTakeResult.rows.length > 0) {
          stockTakeWarning = stockTakeResult.rows[0];
        }
      } catch (e) {
        // Stock take table might not exist yet
      }
      
      const result = await saleService.create(data, sellerId) as any;
      
      cache.invalidateByPrefix('sales:list');
      
      // Log sale creation
      if (result.sale?.id) {
        logActivity({
          userId: sellerId,
          userName: user?.name || user?.email || 'Unknown',
          userEmail: user?.email || '',
          action: 'sale_created',
          entityType: 'sale',
          entityId: result.sale.id,
          shopId: shopId,
          details: {
            saleId: result.sale.id,
            totalAmount: result.sale.total_amount,
            paymentMethod: result.sale.payment_method,
            saleDate: data.saleDate || result.sale.created_at,
            itemCount: result.saleItems?.length || 0,
            products: result.saleItems?.map((i: any) => ({
              name: i.productName,
              qty: i.quantity,
              price: i.totalPrice || i.unitPrice
            })) || []
          }
        }).catch(() => {});
      }
      
      // Flag sale if during stock take
      if (stockTakeWarning && result.sale?.id) {
        try {
          await pool.query(
            `INSERT INTO sales_during_stock_take (sale_id, session_id) VALUES ($1, $2)`,
            [result.sale.id, stockTakeWarning.id]
          );
          result.stockTakeWarning = stockTakeWarning.name;
        } catch (e) {}
      }

      // Auto SMS to customer on sale (fire-and-forget, if enabled by shop)
      if (result.sale?.id && data.customerPhone) {
        handleAutoSmsOnSale({
          shopId,
          customerPhone: data.customerPhone,
          customerName: data.customerName,
          totalAmount: result.sale.totalAmount,
          items: result.saleItems?.map((i: any) => ({
            name: i.productName,
            quantity: i.quantity,
            totalPrice: i.totalPrice || i.unitPrice,
          })) || [],
        }).catch(() => {});
      }

      // Auto SMS to the owner after every sale (fire-and-forget, if enabled)
      if (result.sale?.id) {
        handleAdminSaleSmsOnSale({
          shopId,
          totalAmount: result.sale.totalAmount,
          sellerName: user?.name || user?.email || '',
          customerName: data.customerName,
          items: result.saleItems?.map((i: any) => ({
            name: i.productName,
            quantity: i.quantity,
            totalPrice: i.totalPrice || i.unitPrice,
          })) || [],
        }).catch(() => {});
      }

      return c.json({
        success: true,
        data: result,
        warning: stockTakeWarning ? `This sale was made during stock take: ${stockTakeWarning.name}` : undefined
      }, 201);
    } catch (error: any) {
      return c.json({
        success: false,
        error: error.message
      }, 400);
    }
  }

  async getInvoice(c: Context) {
    try {
      const id = c.req.param('id') as string;
      const tenantId = c.get('tenantId');
      
      const invoice = await saleService.getInvoiceData(id, tenantId);
      
      return c.json({
        success: true,
        data: invoice
      });
    } catch (error: any) {
      return c.json({
        success: false,
        error: error.message
      }, 404);
    }
  }

  async createInvoice(c: Context) {
    try {
      const body = await c.req.json();
      const sellerId = c.get('userId');
      const tenantId = c.get('tenantId');
      
      const invoice = await saleService.createInvoiceFromData(body, sellerId, tenantId);
      
      cache.invalidateByPrefix('sales:list');
      
      return c.json({
        success: true,
        data: invoice
      }, 201);
    } catch (error: any) {
      return c.json({
        success: false,
        error: error.message
      }, 400);
    }
  }

  async deleteInvoice(c: Context) {
    try {
      const saleId = c.req.param('id') as string;
      const tenantId = c.get('tenantId');
      const userRole = c.get('userRole');

      // Sale deletion is reserved for the shop admin/owner. Sellers must never
      // remove a sale, even if a legacy per-shop grant says otherwise.
      if (userRole === 'seller') {
        return c.json({ success: false, error: 'Forbidden - Only shop admins can delete sales' }, 403);
      }

      const user = c.get('user') as any;
      const result = await saleService.deleteInvoice(saleId, tenantId);

      cache.invalidateByPrefix('sales:list');

      // Audit trail - who deleted which sale and why
      logActivity({
        userId: c.get('userId'),
        userName: user?.name || user?.email || 'Unknown',
        userEmail: user?.email || '',
        action: 'sale_deleted',
        entityType: 'sale',
        entityId: saleId,
        shopId: result.shopId,
        details: {
          saleId,
          totalAmount: result.totalAmount,
          itemCount: result.itemCount
        }
      }).catch(() => {});

      return c.json({ success: true, data: result });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 400);
    }
  }

  async recordPayment(c: Context) {
    try {
      const saleId = c.req.param('id') as string;
      const body = await c.req.json();
      const userId = c.get('userId');
      const tenantId = c.get('tenantId');
      
      const result = await saleService.recordPayment(saleId, {
        amount: body.amount,
        paymentMethod: body.paymentMethod || 'cash',
        paymentReference: body.paymentReference,
        notes: body.notes,
        recordedBy: userId
      }, tenantId);
      
      cache.invalidateByPrefix('sales:list');
      
      return c.json({ success: true, data: result }, 201);
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 400);
    }
  }

  async getInvoicePayments(c: Context) {
    try {
      const saleId = c.req.param('id') as string;
      const tenantId = c.get('tenantId');
      
      const result = await saleService.getInvoicePayments(saleId, tenantId);
      
      return c.json({ success: true, data: result });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 400);
    }
  }

  async updatePaymentStatus(c: Context) {
    try {
      const saleId = c.req.param('id') as string;
      const body = await c.req.json();
      const tenantId = c.get('tenantId');
      
      const userId = c.get('userId');
      const result = await saleService.updatePaymentStatus(saleId, body.status, tenantId, userId);
      
      cache.invalidateByPrefix('sales:list');
      
      return c.json({ success: true, data: result });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 400);
    }
  }

  async getSalesAnalytics(c: Context) {
    try {
      const tenantId = c.get('tenantId');
      const userRole = c.get('userRole');
      const userShops = c.get('shopIds');
      const shopId = c.req.query('shopId');
      const startDate = c.req.query('startDate');
      const endDate = c.req.query('endDate');
      
      const result = await saleService.getSalesAnalytics({
        tenantId,
        userRole,
        userShops,
        shopId,
        startDate,
        endDate
      });
      
      return c.json({ success: true, data: result });
    } catch (error: any) {
      console.error('[SalesAnalytics] Overview error:', error.message, error.stack);
      return c.json({ success: false, error: error.message }, 400);
    }
  }
  
  async getCustomerAnalytics(c: Context) {
    try {
      const tenantId = c.get('tenantId');
      const userRole = c.get('userRole');
      const userShops = c.get('shopIds');
      const shopId = c.req.query('shopId');
      const startDate = c.req.query('startDate');
      const endDate = c.req.query('endDate');
      
      const result = await saleService.getCustomerAnalytics({
        tenantId,
        userRole,
        userShops,
        shopId,
        startDate,
        endDate
      });
      
      return c.json({ success: true, data: result });
    } catch (error: any) {
      console.error('[SalesAnalytics] Customer error:', error.message, error.stack);
      return c.json({ success: false, error: error.message }, 400);
    }
  }
  
  async getDepartmentAnalytics(c: Context) {
    try {
      const tenantId = c.get('tenantId');
      const userRole = c.get('userRole');
      const userShops = c.get('shopIds');
      const shopId = c.req.query('shopId');
      const startDate = c.req.query('startDate');
      const endDate = c.req.query('endDate');
      
      const result = await saleService.getDepartmentAnalytics({
        tenantId,
        userRole,
        userShops,
        shopId,
        startDate,
        endDate
      });
      
      return c.json({ success: true, data: result });
    } catch (error: any) {
      console.error('[SalesAnalytics] Department error:', error.message, error.stack);
      return c.json({ success: false, error: error.message }, 400);
    }
  }

  async getProductAnalytics(c: Context) {
    try {
      const tenantId = c.get('tenantId');
      const userRole = c.get('userRole');
      const userShops = c.get('shopIds');
      const shopId = c.req.query('shopId');
      const startDate = c.req.query('startDate');
      const endDate = c.req.query('endDate');
      
      const result = await saleService.getProductAnalytics({
        tenantId,
        userRole,
        userShops,
        shopId,
        startDate,
        endDate
      });
      
      return c.json({ success: true, data: result });
    } catch (error: any) {
      console.error('[SalesAnalytics] Products error:', error.message, error.stack);
      return c.json({ success: false, error: error.message }, 400);
    }
  }

  async update(c: Context) {
    try {
      const id = c.req.param('id') as string;
      const data = c.get('validatedBody');
      const userId = c.get('userId');

      const result = await saleService.update(id, data, userId);

      cache.invalidateByPrefix('sales:list');

      return c.json({ success: true, data: result });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 400);
    }
  }
}

export const saleController = new SaleController();
