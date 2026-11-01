import { productService } from './product.service.js';
import { logActivity } from '../../utils/activity-logger.js';
import { handleNewProductSms } from '../../services/sms-reseller.service.js';
import { hasPermission } from '../../middleware/rbac.middleware.js';
import { checkProductLimit, limitErrorResponse } from '../../services/plan-limits.service.js';
import type { Context } from 'hono';

// Strip cost/buying info from a single product when the caller is a seller that
// is not allowed to view buying prices. Keeps selling data intact.
function scrubProduct(product: any, canSeeBuying: boolean) {
  if (!product || canSeeBuying) return product;
  const scrubbed: any = { ...product };
  delete scrubbed.buyingPrice;
  delete scrubbed.costPerQtyBuyPrice;
  if (scrubbed.fractionPrices && typeof scrubbed.fractionPrices === 'object') {
    const fp: any = {};
    for (const key of Object.keys(scrubbed.fractionPrices)) {
      const val = scrubbed.fractionPrices[key];
      if (val && typeof val === 'object') {
        fp[key] = { ...val };
        delete fp[key].buyingPrice;
        delete fp[key].buy;
      } else {
        fp[key] = val;
      }
    }
    scrubbed.fractionPrices = fp;
  }
  return scrubbed;
}

export class ProductController {
  async getAll(c: Context) {
    try {
      const query = c.get('validatedQuery');
      const tenantId = c.get('tenantId');
      const userShops = c.get('shopIds');
      
      const result = await productService.findAll(query, tenantId, userShops);
      
      // Sellers without product:buying only see selling prices.
      const userRole = c.get('userRole');
      if ((userRole === 'seller') && Array.isArray(result.products)) {
        const userId = c.get('userId');
        const shopId = (userShops || [])[0] as string;
        const canBuying = await hasPermission(userId, userRole, shopId, 'product:buying');
        if (!canBuying) {
          result.products = result.products.map((p: any) => scrubProduct(p, false));
        }
      }
      
      return c.json({
        success: true,
        data: result
      });
    } catch (error: any) {
      console.error('Product fetch error:', error.message);
      return c.json({
        success: false,
        error: error.message || 'Failed to fetch products'
      }, 400);
    }
  }
  
  async getById(c: Context) {
    try {
      const id = c.req.param('id') as string;
      const tenantId = c.get('tenantId');
      
      const product = await productService.findById(id, tenantId);
      
      const userRole = c.get('userRole');
      if (userRole === 'seller') {
        const userId = c.get('userId');
        const shopId = product?.shopId as string;
        const canBuying = await hasPermission(userId, userRole, shopId, 'product:buying');
        product && scrubProduct(product, canBuying);
      }
      
      return c.json({
        success: true,
        data: { product }
      });
    } catch (error: any) {
      if (error.message === 'Product not found') {
        return c.json({
          success: false,
          error: 'Product not found'
        }, 404);
      }
      throw error;
    }
  }
  
  async getByBarcode(c: Context) {
    try {
      const barcode = c.req.param('barcode') as string;
      const shopId = c.req.query('shopId');
      
      if (!shopId) {
        return c.json({
          success: false,
          error: 'shopId is required'
        }, 400);
      }
      
      const product = await productService.findByBarcode(barcode, shopId);
      
      const userRole = c.get('userRole');
      if (userRole === 'seller' && product) {
        const userId = c.get('userId');
        const canBuying = await hasPermission(userId, userRole, product.shopId || shopId, 'product:buying');
        scrubProduct(product, canBuying);
      }
      
      return c.json({
        success: true,
        data: { product }
      });
    } catch (error: any) {
      if (error.message === 'Product not found') {
        return c.json({
          success: false,
          error: 'Product not found'
        }, 404);
      }
      throw error;
    }
  }
  
  async sync(c: Context) {
    try {
      const shopId = c.req.query('shopId');
      const since = c.req.query('since') || '1970-01-01T00:00:00.000Z';
      const afterId = c.req.query('afterId') || '';
      const limit = c.req.query('limit');

      if (!shopId) {
        return c.json({
          success: false,
          error: 'shopId is required'
        }, 400);
      }

      const userRole = c.get('userRole');
      const userShops = (c.get('shopIds') as string[]) || [];
      if (userRole !== 'developer' && !userShops.includes(shopId)) {
        return c.json({
          success: false,
          error: 'Access denied to this shop'
        }, 403);
      }

      const result = await productService.getChangesSince(shopId, since, afterId, parseInt(limit || '500', 10));

      // Sellers without product:buying only see selling prices — same rule as
      // the regular product list.
      if (userRole === 'seller' && Array.isArray(result.products)) {
        const userId = c.get('userId');
        const canBuying = await hasPermission(userId, userRole, shopId, 'product:buying');
        if (!canBuying) {
          result.products = result.products.map((p: any) => scrubProduct(p, false));
        }
      }

      return c.json({
        success: true,
        data: result
      });
    } catch (error: any) {
      console.error('Product sync error:', error.message);
      return c.json({
        success: false,
        error: error.message || 'Failed to sync products'
      }, 400);
    }
  }
  
  async create(c: Context) {
    try {
      const data = c.get('validatedBody');
      const userId = c.get('userId');
      const user = c.get('user') as any;
      const shopId = data.shopId;
      const tenantId = c.get('tenantId') as string;
      const userRole = c.get('userRole') as string;

      // Plan/trial product limit — never blocks a developer.
      if (userRole !== 'developer' && tenantId) {
        const gate = await checkProductLimit(tenantId, 1);
        const limitError = limitErrorResponse(gate);
        if (limitError) return c.json(limitError, 403);
      }

      const product = await productService.create(data, userId);

      // Auto SMS to customers on new product (fire-and-forget, if enabled by shop)
      if (product?.id && data.shopId) {
        handleNewProductSms({
          shopId: data.shopId,
          productName: product.name || data.name,
        }).catch(() => {});
      }
      
      // Log product creation
      await logActivity({
        userId: userId,
        userName: user?.name || user?.email || 'Unknown',
        userEmail: user?.email || '',
        action: 'product_created',
        shopId: shopId,
        details: {
          productId: product.id,
          productName: product.name,
          productSku: product.sku
        }
      });
      
      return c.json({
        success: true,
        data: { product }
      }, 201);
    } catch (error: any) {
      if (error.message?.includes('unique constraint')) {
        return c.json({
          success: false,
          error: 'SKU or barcode already exists'
        }, 409);
      }
      throw error;
    }
  }
  
  async update(c: Context) {
    try {
      const id = c.req.param('id') as string;
      const data = c.get('validatedBody');
      const tenantId = c.get('tenantId');
      const userId = c.get('userId');
      const user = c.get('user') as any;
      
      const product = await productService.update(id, data, tenantId);
      
      // Log product update
      await logActivity({
        userId: userId,
        userName: user?.name || user?.email || 'Unknown',
        userEmail: user?.email || '',
        action: 'product_updated',
        shopId: product.shopId,
        details: {
          productId: product.id,
          productName: product.name,
          productSku: product.sku,
          changes: Object.keys(data)
        }
      });
      
      return c.json({
        success: true,
        data: { product }
      });
    } catch (error: any) {
      if (error.message === 'Product not found') {
        return c.json({
          success: false,
          error: 'Product not found'
        }, 404);
      }
      throw error;
    }
  }
  
  async delete(c: Context) {
    try {
      const id = c.req.param('id') as string;
      const userId = c.get('userId');
      const user = c.get('user') as any;
      
      const deleted = await productService.hardDelete(id);
      
      if (!deleted) {
        return c.json({
          success: false,
          error: 'Cannot delete: product has associated sales'
        }, 409);
      }
      
      // Log product deletion
      await logActivity({
        userId: userId,
        userName: user?.name || user?.email || 'Unknown',
        userEmail: user?.email || '',
        action: 'product_deleted',
        shopId: undefined,
        details: {
          productId: id
        }
      });
      
      return c.json({
        success: true,
        message: 'Product deleted successfully'
      });
    } catch (error: any) {
      if (error.message === 'Product not found') {
        return c.json({
          success: false,
          error: 'Product not found'
        }, 404);
      }
      throw error;
    }
  }

  async bulkDelete(c: Context) {
    try {
      const body = await c.req.json();
      const { productIds } = body;
      const userRole = c.get('userRole');
      const shopIds = c.get('shopIds') as string[];
      const userId = c.get('userId');
      
      console.log('[BulkDelete] userRole:', userRole, 'shopIds:', shopIds, 'productIds:', productIds);
      
      if (!productIds || !Array.isArray(productIds) || productIds.length === 0) {
        return c.json({
          success: false,
          error: 'Product IDs are required'
        }, 400);
      }
      
      // Check access for each product
      const accessibleIds: string[] = [];
      for (const productId of productIds) {
        if (userRole === 'developer' || userRole === 'admin' || userRole === 'owner') {
          accessibleIds.push(productId);
        } else {
          try {
            const product = await productService.findById(productId, '');
            console.log('[BulkDelete] Product:', productId, 'shopId:', product?.shopId);
            if (product && shopIds.includes(product.shopId)) {
              accessibleIds.push(productId);
            }
          } catch (e) {
            // Product not found or access denied
          }
        }
      }
      
      console.log('[BulkDelete] Accessible IDs:', accessibleIds);
      
      if (accessibleIds.length === 0) {
        return c.json({
          success: false,
          error: 'Access denied to these products'
        }, 403);
      }
      
      const result = await productService.bulkDelete(accessibleIds);
      
      let message = `${result.deletedCount} products deleted successfully`;
      if (result.skippedCount > 0) {
        message += `. ${result.skippedCount} product(s) skipped (have associated sales)`;
      }
      
      return c.json({
        success: true,
        message
      });
    } catch (error: any) {
      return c.json({
        success: false,
        error: error.message
      }, 400);
    }
  }
  
  async addCargo(c: Context) {
    try {
      const productId = c.req.param('id') as string;
      const data = c.get('validatedBody');
      const userId = c.get('userId');
      
      const result = await productService.addCargo(productId, data, userId);
      
      return c.json({
        success: true,
        data: result
      }, 201);
    } catch (error: any) {
      throw error;
    }
  }

  async importProducts(c: Context) {
    try {
      const body = await c.req.json();
      const { shopId, products } = body;
      const userId = c.get('userId');
      const userRole = c.get('userRole');
      const shopIds = c.get('shopIds') as string[];
      
      if (!shopId || !products || !Array.isArray(products)) {
        return c.json({
          success: false,
          error: 'shopId and products array are required'
        }, 400);
      }
      
      // Check if user has access to this shop
      if (userRole !== 'developer' && !shopIds.includes(shopId)) {
        return c.json({
          success: false,
          error: 'Access denied to this shop'
        }, 403);
      }

      // Plan/trial product limit for the whole import batch.
      const tenantId = c.get('tenantId') as string;
      if (userRole !== 'developer' && tenantId) {
        const gate = await checkProductLimit(tenantId, products.length);
        const limitError = limitErrorResponse(gate);
        if (limitError) return c.json(limitError, 403);
      }

      const result = await productService.importProducts(shopId, products, userId);
      
      // Log product import
      const user = c.get('user') as any;
      await logActivity({
        userId,
        userName: user?.name || user?.email || 'Unknown',
        userEmail: user?.email || '',
        action: 'products_imported',
        shopId,
        details: { count: result?.successCount || products.length }
      });
      
      return c.json({
        success: true,
        data: result
      });
    } catch (error: any) {
      return c.json({
        success: false,
        error: error.message
      }, 400);
    }
  }
}

export const productController = new ProductController();
