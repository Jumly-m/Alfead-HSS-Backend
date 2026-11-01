import { db as readDb } from '../../config/database.js';
import { pool } from '../../config/drizzle.js';
import type { z } from 'zod';
import type { createExpenseSchema, expenseQuerySchema } from './expense.schema.js';

type CreateExpenseInput = z.infer<typeof createExpenseSchema>;
type ExpenseQueryInput = z.infer<typeof expenseQuerySchema>;

export class ExpenseService {
  async create(data: CreateExpenseInput, userId: string, tenantId?: string) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      let amount = data.amount;
      let totalFromWorkers = 0;

      if (data.workers && data.workers.length > 0) {
        totalFromWorkers = data.workers.reduce((sum, w) => sum + w.amount, 0);
        amount = totalFromWorkers;
      }

      // Idempotent replay: if this offline-created expense already exists,
      // return it instead of inserting a duplicate.
      if (data.id) {
        const existing = await client.query(`SELECT * FROM expenses WHERE id = $1`, [data.id]);
        if (existing.rows.length > 0) {
          await client.query('COMMIT');
          return this.formatExpense(existing.rows[0]);
        }
      }

      const result = await client.query(
        `INSERT INTO expenses (id, shop_id, tenant_id, category, description, amount, date, paid_to, details, period_start, period_end, created_by)
         VALUES (COALESCE($1::uuid, uuid_generate_v4()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          data.id || null, data.shopId, tenantId || null, data.category, data.description || null,
          amount, data.date,
          data.paidTo || null, JSON.stringify(data.details || {}),
          data.periodStart || null, data.periodEnd || null, userId
        ]
      );

      const expense = result.rows[0];

      if (data.workers && data.workers.length > 0) {
        for (const w of data.workers) {
          await client.query(
            `INSERT INTO expense_workers (expense_id, name, amount) VALUES ($1, $2, $3)`,
            [expense.id, w.name, w.amount]
          );
        }
      }

      await client.query('COMMIT');
      return this.formatExpense(expense);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async findAll(query: ExpenseQueryInput, shopIds: string[]) {
    const { shopId, startDate, endDate, category, page = 1, limit = 50 } = query;
    const offset = (page - 1) * limit;

    let whereClause = 'WHERE e.shop_id = ANY($1)';
    const params: any[] = [shopIds];
    let paramIndex = 2;

    if (shopId && shopIds.includes(shopId)) {
      whereClause = 'WHERE e.shop_id = $1';
      params[0] = shopId;
    }

    if (startDate) {
      whereClause += ` AND e.date >= $${paramIndex}`;
      params.push(startDate);
      paramIndex++;
    }

    if (endDate) {
      whereClause += ` AND e.date <= $${paramIndex}`;
      params.push(endDate);
      paramIndex++;
    }

    if (category) {
      whereClause += ` AND e.category = $${paramIndex}`;
      params.push(category);
      paramIndex++;
    }

    const countResult = await readDb.read(
      `SELECT COUNT(*) FROM expenses e ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count);

    const result = await readDb.read(
      `SELECT e.*, u.first_name || ' ' || COALESCE(u.last_name, '') as created_by_name
       FROM expenses e
       LEFT JOIN "user" u ON e.created_by = u.id
       ${whereClause}
       ORDER BY e.date DESC, e.created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset]
    );

    const expenseRows = result.rows;

    // Fetch workers for all expenses
    const expenseIds = expenseRows.map((r: any) => r.id);
    let workersMap: Record<string, any[]> = {};
    if (expenseIds.length > 0) {
      const workersResult = await readDb.read(
        `SELECT * FROM expense_workers WHERE expense_id = ANY($1) ORDER BY name`,
        [expenseIds]
      );
      for (const w of workersResult.rows) {
        if (!workersMap[w.expense_id]) workersMap[w.expense_id] = [];
        workersMap[w.expense_id].push({ id: w.id, name: w.name, amount: parseFloat(w.amount) });
      }
    }

    const expenses = expenseRows.map((r: any) => ({
      ...this.formatExpense(r),
      workers: workersMap[r.id] || []
    }));

    const totalResult = await readDb.read(
      `SELECT COALESCE(SUM(amount), 0) as total FROM expenses e ${whereClause}`,
      params
    );

    const categoriesResult = await readDb.read(
      `SELECT category,
              SUM(amount) as total,
              COUNT(*) as count,
              AVG(amount) as avg_amount,
              MAX(amount) as max_amount
       FROM expenses e ${whereClause}
       GROUP BY category
       ORDER BY total DESC`,
      params
    );

    const topExpensesResult = await readDb.read(
      `SELECT e.id, e.category, e.description, e.paid_to, e.amount, e.date
       FROM expenses e ${whereClause}
       ORDER BY e.amount DESC, e.date DESC
       LIMIT 5`,
      params
    );

    return {
      expenses,
      categories: categoriesResult.rows.map((c: any) => ({
        category: c.category,
        total: parseFloat(c.total),
        count: parseInt(c.count),
        average: parseFloat(c.avg_amount) || 0,
        largest: parseFloat(c.max_amount) || 0
      })),
      topExpenses: topExpensesResult.rows.map((r: any) => ({
        id: r.id,
        category: r.category,
        description: r.description,
        paidTo: r.paid_to,
        amount: parseFloat(r.amount) || 0,
        date: r.date
      })),
      totalAmount: parseFloat(totalResult.rows[0].total),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    };
  }

  async delete(id: string, shopIds: string[]) {
    const result = await pool.query(
      `DELETE FROM expenses WHERE id = $1 AND shop_id = ANY($2) RETURNING id`,
      [id, shopIds]
    );

    if (result.rows.length === 0) {
      throw new Error('Expense not found');
    }

    return { success: true };
  }

  async update(id: string, data: any, shopIds: string[]) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const updates: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;

      if (data.category !== undefined) {
        updates.push(`category = $${paramIndex++}`);
        params.push(data.category);
      }
      if (data.description !== undefined) {
        updates.push(`description = $${paramIndex++}`);
        params.push(data.description);
      }
      if (data.amount !== undefined) {
        updates.push(`amount = $${paramIndex++}`);
        params.push(data.amount);
      }
      if (data.date !== undefined) {
        updates.push(`date = $${paramIndex++}`);
        params.push(data.date);
      }
      if (data.paidTo !== undefined) {
        updates.push(`paid_to = $${paramIndex++}`);
        params.push(data.paidTo);
      }
      if (data.details !== undefined) {
        updates.push(`details = $${paramIndex++}`);
        params.push(JSON.stringify(data.details));
      }
      if (data.periodStart !== undefined) {
        updates.push(`period_start = $${paramIndex++}`);
        params.push(data.periodStart);
      }
      if (data.periodEnd !== undefined) {
        updates.push(`period_end = $${paramIndex++}`);
        params.push(data.periodEnd);
      }

      if (updates.length === 0) {
        throw new Error('No fields to update');
      }

      params.push(id);
      params.push(shopIds);

      const result = await client.query(
        `UPDATE expenses SET ${updates.join(', ')}, updated_at = NOW()
         WHERE id = $${paramIndex++} AND shop_id = ANY($${paramIndex++})
         RETURNING *`,
        params
      );

      if (result.rows.length === 0) {
        throw new Error('Expense not found');
      }

      // Replace workers if provided
      if (data.workers !== undefined) {
        await client.query(`DELETE FROM expense_workers WHERE expense_id = $1`, [id]);
        for (const w of data.workers) {
          await client.query(
            `INSERT INTO expense_workers (expense_id, name, amount) VALUES ($1, $2, $3)`,
            [id, w.name, w.amount]
          );
        }
      }

      await client.query('COMMIT');

      const expense = result.rows[0];
      const workersRes = await client.query(
        `SELECT * FROM expense_workers WHERE expense_id = $1 ORDER BY name`,
        [id]
      );

      return {
        ...this.formatExpense(expense),
        workers: workersRes.rows.map((w: any) => ({
          id: w.id, name: w.name, amount: parseFloat(w.amount)
        }))
      };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async getCategories(shopIds: string[]) {
    const result = await pool.query(
      `SELECT DISTINCT category FROM expenses WHERE shop_id = ANY($1) ORDER BY category`,
      [shopIds]
    );

    return result.rows.map(r => r.category);
  }

  // Category management methods
  async getCategoryList(shopIds: string[]) {
    const result = await pool.query(
      `SELECT * FROM expense_categories WHERE shop_id = ANY($1) OR shop_id IS NULL ORDER BY name ASC`,
      [shopIds]
    );

    return result.rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      isDefault: r.is_default,
      shopId: r.shop_id,
      createdAt: r.created_at
    }));
  }

  async createCategory(data: { name: string; description?: string }, shopId: string, userId: string) {
    const existing = await pool.query(
      `SELECT id FROM expense_categories WHERE LOWER(name) = LOWER($1) AND (shop_id = $2 OR shop_id IS NULL)`,
      [data.name, shopId]
    );

    if (existing.rows.length > 0) {
      throw new Error('Category with this name already exists');
    }

    const result = await pool.query(
      `INSERT INTO expense_categories (name, description, shop_id, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [data.name, data.description || null, shopId, userId]
    );

    return {
      id: result.rows[0].id,
      name: result.rows[0].name,
      description: result.rows[0].description,
      isDefault: result.rows[0].is_default,
      shopId: result.rows[0].shop_id,
      createdAt: result.rows[0].created_at
    };
  }

  async updateCategory(id: string, data: { name?: string; description?: string }, shopIds: string[]) {
    const updates: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (data.name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      params.push(data.name);
    }
    if (data.description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      params.push(data.description);
    }

    if (updates.length === 0) {
      throw new Error('No fields to update');
    }

    params.push(id);
    params.push(shopIds);

    const result = await pool.query(
      `UPDATE expense_categories SET ${updates.join(', ')}, updated_at = NOW()
       WHERE id = $${paramIndex++} AND (shop_id = ANY($${paramIndex++}) OR is_default = TRUE)
       RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      throw new Error('Category not found');
    }

    return {
      id: result.rows[0].id,
      name: result.rows[0].name,
      description: result.rows[0].description,
      isDefault: result.rows[0].is_default,
      shopId: result.rows[0].shop_id,
      updatedAt: result.rows[0].updated_at
    };
  }

  async deleteCategory(id: string, shopIds: string[]) {
    const result = await pool.query(
      `DELETE FROM expense_categories WHERE id = $1 AND (shop_id = ANY($2) OR is_default = TRUE) RETURNING id`,
      [id, shopIds]
    );

    if (result.rows.length === 0) {
      throw new Error('Category not found');
    }

    return { success: true };
  }

  private formatExpense(row: any) {
    return {
      id: row.id,
      shopId: row.shop_id,
      category: row.category,
      description: row.description,
      amount: parseFloat(row.amount),
      paidTo: row.paid_to,
      details: row.details,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      date: row.date,
      createdBy: row.created_by,
      createdByName: row.created_by_name,
      createdAt: row.created_at
    };
  }
}

export const expenseService = new ExpenseService();
