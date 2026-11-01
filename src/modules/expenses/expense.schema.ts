import { z } from 'zod';

export const workerSchema = z.object({
  name: z.string().min(1, 'Worker name is required'),
  amount: z.coerce.number().positive('Amount must be positive')
});

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const createExpenseSchema = z.object({
  // Client-generated id for offline-created expenses (replay-safe creates).
  id: z.string().regex(uuidRegex, 'Invalid id format').optional(),
  shopId: z.string().regex(uuidRegex, 'Invalid shop ID format'),
  category: z.string().min(1),
  description: z.string().optional(),
  amount: z.coerce.number().positive(),
  date: z.string(),
  paidTo: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  periodStart: z.string().optional(),
  periodEnd: z.string().optional(),
  workers: z.array(workerSchema).optional()
});

export const expenseQuerySchema = z.object({
  shopId: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  category: z.string().optional(),
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().optional().default(50)
});
