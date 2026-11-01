import { z } from "zod";

export const createCategorySchema = z.object({
  shopId: z.string().uuid().min(1),
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
});

export const updateCategorySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().optional().nullable(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional().nullable(),
});

export const reassignProductsSchema = z.object({
  shopId: z.string().uuid().min(1),
  categoryId: z.string().uuid().nullable(),
  productIds: z.array(z.string().uuid()).min(1).max(5000),
});
