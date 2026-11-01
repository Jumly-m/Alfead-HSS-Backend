import { z } from "zod";

const DEC12_2_MAX = 9999999999;
const DEC12_4_MAX = 99999999;
const DEC10_4_MAX = 999999;

export const createProductSchema = z.object({
  // Client-generated id for offline-created products. Replays carry the same
  // id, so the server can return the existing row instead of duplicating it.
  id: z.string().uuid().optional(),
  shopId: z.string().min(1),
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  sku: z.string().optional(),
  categoryId: z.string().optional(),
  buyingPrice: z.coerce.number().min(0).max(DEC12_2_MAX),
  sellingPrice: z.coerce.number().min(0).max(DEC12_2_MAX).optional(),
  initialStock: z.coerce.number().min(0).max(DEC12_4_MAX).default(0),
  lowStockThreshold: z.coerce.number().min(0).max(DEC12_4_MAX).default(10),
  expiryDate: z.string().datetime().nullable().optional(),
  images: z.array(z.string()).optional(),
  generateBarcode: z.boolean().default(true),
  enableFractions: z.boolean().default(false),
  fractionTypes: z.array(z.string()).default([]),
  fractionPrices: z.record(z.string(), z.coerce.number().min(0).max(DEC12_2_MAX)).default({}),
  unitType: z.string().default('PCS'),
  requiresDimensions: z.boolean().default(false),
  dimensionUnit: z.enum(['cm', 'm']).default('m'),
  unitConversions: z.record(z.string(), z.object({
    price: z.coerce.number().min(0).max(DEC12_2_MAX).optional(),
    factor: z.coerce.number().min(0).max(DEC12_4_MAX).optional(),
    // Wholesale packs: friendly pack name (shown in POS) + the marker that
    // tells the product form this conversion is a jumla pack.
    stockUnit: z.string().max(60).optional(),
    isWholesale: z.boolean().optional(),
  })).default({}),
  fullProductLength: z.coerce.number().min(0).max(DEC10_4_MAX).optional(),
  fullProductWidth: z.coerce.number().min(0).max(DEC10_4_MAX).optional(),
  fullProductPrice: z.coerce.number().min(0).max(DEC12_2_MAX).optional(),
  costPerQty: z.coerce.number().min(0).max(DEC12_4_MAX).default(1),
  costPerQtyPrice: z.coerce.number().min(0).max(DEC12_2_MAX).default(0),
  costPerQtyBuyPrice: z.coerce.number().min(0).max(DEC12_2_MAX).default(0),
});

export const updateProductSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  categoryId: z.string().optional(),
  sellingPrice: z.coerce.number().min(0).max(DEC12_2_MAX).optional(),
  buyingPrice: z.coerce.number().min(0).max(DEC12_2_MAX).optional(),
  currentStock: z.coerce.number().min(0).max(DEC12_4_MAX).optional(),
  lowStockThreshold: z.coerce.number().min(0).max(DEC12_4_MAX).optional(),
  expiryDate: z.string().datetime().nullable().optional(),
  images: z.array(z.string()).optional(),
  isActive: z.boolean().optional(),
  enableFractions: z.boolean().optional(),
  fractionTypes: z.array(z.string()).optional(),
  fractionPrices: z.record(z.string(), z.coerce.number().min(0).max(DEC12_2_MAX)).optional(),
  unitType: z.string().optional(),
  requiresDimensions: z.boolean().optional(),
  dimensionUnit: z.enum(['cm', 'm']).optional(),
  unitConversions: z.record(z.string(), z.object({
    price: z.coerce.number().min(0).max(DEC12_2_MAX).optional(),
    factor: z.coerce.number().min(0).max(DEC12_4_MAX).optional(),
    stockUnit: z.string().max(60).optional(),
    isWholesale: z.boolean().optional(),
  })).optional(),
  fullProductLength: z.coerce.number().min(0).max(DEC10_4_MAX).optional(),
  fullProductWidth: z.coerce.number().min(0).max(DEC10_4_MAX).optional(),
  fullProductPrice: z.coerce.number().min(0).max(DEC12_2_MAX).optional(),
  costPerQty: z.coerce.number().min(0).max(DEC12_4_MAX).optional(),
  costPerQtyPrice: z.coerce.number().min(0).max(DEC12_2_MAX).optional(),
  costPerQtyBuyPrice: z.coerce.number().min(0).max(DEC12_2_MAX).optional(),
});

export const addCargoSchema = z.object({
  quantity: z.coerce.number().min(0.0001).max(DEC12_4_MAX),
  buyingPricePerUnit: z.coerce.number().min(0).max(DEC12_2_MAX),
  transportCost: z.coerce.number().min(0).max(DEC12_2_MAX).default(0),
  supplierName: z.string().optional(),
  supplierContact: z.string().optional(),
  notes: z.string().optional()
});

export const productQuerySchema = z.object({
  shopId: z.string().min(1).optional(),
  search: z.string().optional().or(z.literal('')),
  categoryId: z.string().optional().or(z.literal('')),
  lowStock: z.coerce.boolean().optional(),
  expiring: z.coerce.boolean().optional(),
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().optional().default(20),
  sortBy: z.enum(['name', 'createdAt', 'stock', 'price']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc')
});
