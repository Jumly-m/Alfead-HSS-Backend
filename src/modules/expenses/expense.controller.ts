import { expenseService } from './expense.service.js';
import { logActivity } from '../../utils/activity-logger.js';
import type { Context } from 'hono';

export class ExpenseController {
  async create(c: Context) {
    try {
      const body = await c.req.json();
      const userId = (c as any).get('userId');
      let tenantId = (c as any).get('tenantId');
      const shopIds = (c as any).get('shopIds') as string[];

      if (!shopIds || shopIds.length === 0) {
        return c.json({ success: false, error: 'No shop access' }, 400);
      }

      // Use trusted shopId from auth context
      // Prefer client-provided shopId if it's in the user's accessible shops
      if (body.shopId && shopIds.includes(body.shopId)) {
        // Client's shopId is valid - use it
      } else {
        body.shopId = shopIds[0];
      }

      // If tenantId is not set, try to get it from the user's shop
      if (!tenantId) {
        const pool = (await import('../../config/drizzle.js')).pool;
        const shopResult = await pool.query('SELECT tenant_id FROM shops WHERE id = $1', [shopIds[0]]);
        if (shopResult.rows.length > 0) {
          tenantId = shopResult.rows[0].tenant_id;
        }
      }

      // Ensure tenantId is set
      if (!tenantId) {
        return c.json({
          success: false,
          error: 'Tenant ID not found. Please ensure you are associated with a shop.'
        }, 400);
      }

      const expense = await expenseService.create(body, userId, tenantId);

      // Log expense creation
      const user = (c as any).get('user');
      await logActivity({
        userId,
        userName: user?.name || user?.email || 'Unknown',
        userEmail: user?.email || '',
        action: 'expense_created',
        entityType: 'expense',
        entityId: expense?.id,
        shopId: body.shopId,
        details: {
          category: body.category,
          amount: body.amount,
          description: body.description
        }
      });

      return c.json({
        success: true,
        data: expense
      }, 201);
    } catch (error: any) {
      console.error('[ExpenseController] create error:', error.message, error.stack?.split('\n').slice(0, 3).join('\n'));
      return c.json({
        success: false,
        error: error.message
      }, 400);
    }
  }

  async getAll(c: Context) {
    try {
      const query: any = c.req.query();
      const shopIds = (c as any).get('shopIds') as string[];

      if (!shopIds || shopIds.length === 0) {
        return c.json({ success: false, error: 'No shop access' }, 400);
      }
      
      const result = await expenseService.findAll(query, shopIds);
      
      return c.json({
        success: true,
        data: result
      });
    } catch (error: any) {
      console.error('[ExpenseController] getAll error:', error.message, error.stack?.split('\n').slice(0, 3).join('\n'));
      return c.json({
        success: false,
        error: error.message
      }, 400);
    }
  }

  async delete(c: Context) {
    try {
      const id = c.req.param('id') as string;
      const shopIds = (c as any).get('shopIds') as string[];
      
      await expenseService.delete(id, shopIds);
      
      // Log expense deletion
      const user = (c as any).get('user');
      const userId = (c as any).get('userId');
      await logActivity({
        userId,
        userName: user?.name || user?.email || 'Unknown',
        userEmail: user?.email || '',
        action: 'expense_deleted',
        entityType: 'expense',
        entityId: id,
        shopId: shopIds?.[0],
        details: { deletedExpenseId: id }
      });
      
      return c.json({
        success: true,
        message: 'Expense deleted successfully'
      });
    } catch (error: any) {
      return c.json({
        success: false,
        error: error.message
      }, 400);
    }
  }

  async getCategories(c: Context) {
    try {
      const shopIds = (c as any).get('shopIds') as string[];
      
      const categories = await expenseService.getCategories(shopIds);
      
      return c.json({
        success: true,
        data: categories
      });
    } catch (error: any) {
      return c.json({
        success: false,
        error: error.message
      }, 400);
    }
  }

  async update(c: Context) {
    try {
      const id = c.req.param('id') as string;
      const body = await c.req.json();
      const shopIds = (c as any).get('shopIds') as string[];
      
      if (!shopIds || shopIds.length === 0) {
        return c.json({ success: false, error: 'No shop access' }, 400);
      }
      body.shopId = shopIds[0];
      
      const expense = await expenseService.update(id, body, shopIds);
      
      // Log expense update
      const user = (c as any).get('user');
      const userId = (c as any).get('userId');
      await logActivity({
        userId,
        userName: user?.name || user?.email || 'Unknown',
        userEmail: user?.email || '',
        action: 'expense_updated',
        entityType: 'expense',
        entityId: expense?.id,
        shopId: shopIds?.[0],
        details: {
          changes: Object.keys(body),
          newAmount: body.amount,
          newCategory: body.category
        }
      });
      
      return c.json({
        success: true,
        data: expense
      });
    } catch (error: any) {
      return c.json({
        success: false,
        error: error.message
      }, 400);
    }
  }

  async getCategoryList(c: Context) {
    try {
      const shopIds = (c as any).get('shopIds') as string[];
      
      const categories = await expenseService.getCategoryList(shopIds);
      
      return c.json({
        success: true,
        data: categories
      });
    } catch (error: any) {
      return c.json({
        success: false,
        error: error.message
      }, 400);
    }
  }

  async createCategory(c: Context) {
    try {
      const body = await c.req.json();
      const userId = (c as any).get('userId');
      const shopIds = (c as any).get('shopIds') as string[];
      
      if (!shopIds || shopIds.length === 0) {
        return c.json({
          success: false,
          error: 'No shop access found'
        }, 400);
      }
      
      if (!body.name || body.name.trim() === '') {
        return c.json({
          success: false,
          error: 'Category name is required'
        }, 400);
      }
      
      const category = await expenseService.createCategory(
        { name: body.name.trim(), description: body.description },
        shopIds[0],
        userId
      );
      
      // Log expense category creation
      const user = (c as any).get('user');
      await logActivity({
        userId,
        userName: user?.name || user?.email || 'Unknown',
        userEmail: user?.email || '',
        action: 'expense_category_created',
        entityType: 'expense_category',
        entityId: category?.id,
        shopId: shopIds[0],
        details: { name: body.name }
      });
      
      return c.json({
        success: true,
        data: category
      }, 201);
    } catch (error: any) {
      return c.json({
        success: false,
        error: error.message
      }, 400);
    }
  }

  async updateCategory(c: Context) {
    try {
      const id = c.req.param('id') as string;
      const body = await c.req.json();
      const shopIds = (c as any).get('shopIds') as string[];
      
      const category = await expenseService.updateCategory(id, body, shopIds);
      
      return c.json({
        success: true,
        data: category
      });
    } catch (error: any) {
      return c.json({
        success: false,
        error: error.message
      }, 400);
    }
  }

  async deleteCategory(c: Context) {
    try {
      const id = c.req.param('id') as string;
      const shopIds = (c as any).get('shopIds') as string[];
      
      await expenseService.deleteCategory(id, shopIds);
      
      return c.json({
        success: true,
        message: 'Category deleted successfully'
      });
    } catch (error: any) {
      return c.json({
        success: false,
        error: error.message
      }, 400);
    }
  }
}

export const expenseController = new ExpenseController();
