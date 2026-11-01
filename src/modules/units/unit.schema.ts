import { z } from "zod";

export const createUnitSchema = z.object({
  shopId: z.string().min(1),
  name: z.string().min(1).max(50),
  code: z.string().min(1).max(20).regex(/^[A-Z0-9_]+$/, "Code must be uppercase letters, numbers, and underscores only"),
  abbreviation: z.string().max(10).optional(),
  decimalPlaces: z.coerce.number().int().min(0).max(4).default(2),
  stockMultiplier: z.coerce.number().min(0.000001).default(1),
  sortOrder: z.coerce.number().int().default(0),
});

export const updateUnitSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  abbreviation: z.string().max(10).optional(),
  decimalPlaces: z.coerce.number().int().min(0).max(4).optional(),
  stockMultiplier: z.coerce.number().min(0.000001).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.coerce.number().int().optional(),
});
