import { z } from 'zod';

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const createSaleSchema = z.object({
  shopId: z.string().min(1).regex(uuidRegex, "Invalid shop ID format"),
  items: z.array(z.object({
    productId: z.preprocess(v => v === '' || v === null ? undefined : v, z.string().regex(uuidRegex, "Invalid product ID format").optional()),
    productName: z.string().optional(),
    quantity: z.coerce.number().min(0.0001),
    unitPrice: z.coerce.number().min(0).optional(),
    fractionType: z.string().default('whole'),
    discount: z.coerce.number().min(0).default(0),
    totalPrice: z.coerce.number().min(0).optional(),
    unitType: z.string().optional(),
    dimensionL: z.coerce.number().min(0).optional(),
    dimensionW: z.coerce.number().min(0).optional(),
    dimensionH: z.coerce.number().min(0).optional(),
    dimensionLabel: z.string().optional(),
    buyingPrice: z.coerce.number().min(0).optional(),
    buyingPriceQty: z.coerce.number().min(0).optional(),
  })).min(1),
  paymentMethod: z.enum(['cash', 'lipa_namba', 'debt', 'bank']),
  amountPaid: z.coerce.number().min(0),
  discountAmount: z.coerce.number().min(0).default(0),
  customerName: z.string().optional(),
  customerPhone: z.string().optional(),
  customerEmail: z.string().email().optional(),
  customerAddress: z.string().optional(),
  customerTin: z.string().optional(),
  customerVrn: z.string().optional(),
  notes: z.string().optional(),
  bankName: z.string().optional(),
  // Optional backdating: the calendar date (YYYY-MM-DD) this sale should be
  // recorded on. When omitted the sale uses the current timestamp. Future dates
  // are rejected in the service layer.
  saleDate: z.preprocess(
    (v) => (v === '' || v === null || v === undefined ? undefined : v),
    z.string().optional()
  ),
  // Client-generated reference for a POS/offline sale. The same reference
  // replayed later (queued while offline, or retried after a lost response)
  // must never produce a second sale — see SaleService.create.
  offlineId: z.preprocess(
    (v) => (v === '' || v === null || v === undefined ? undefined : String(v)),
    z.string().min(1).max(255).optional()
  ),
  source: z.enum(['pos', 'chat']).optional().default('pos')
});

export const updateSaleSchema = z.object({
  customerName: z.string().optional().nullable().default(null),
  customerPhone: z.string().optional().nullable().default(null),
  customerEmail: z.string().optional().nullable().default(null),
  customerAddress: z.string().optional().nullable().default(null),
  customerTin: z.string().optional().nullable().default(null),
  customerVrn: z.string().optional().nullable().default(null),
  customerCompany: z.string().optional().nullable().default(null),
  notes: z.string().optional().nullable().default(null),
  dueDate: z.string().optional().nullable().default(null),
  paymentMethod: z.string().optional(),
  paymentReference: z.string().optional().nullable().default(null),
  discountAmount: z.coerce.number().min(0).optional(),
  items: z.array(z.object({
    productId: z.string().optional().nullable().default(null),
    productName: z.string().default(''),
    quantity: z.coerce.number().min(0).default(1),
    unitPrice: z.coerce.number().min(0).default(0),
    fractionType: z.string().default('whole'),
    discount: z.coerce.number().min(0).default(0),
    unitType: z.string().optional().nullable().default(null),
    buyingPrice: z.coerce.number().min(0).optional(),
    buyingPriceQty: z.coerce.number().min(0).optional(),
  })).optional(),
});

export const saleQuerySchema = z.object({
  shopId: z.string().optional().or(z.literal('')),
  sellerId: z.string().optional().or(z.literal('')),
  paymentMethod: z.enum(['cash', 'lipa_namba', 'debt', 'bank']).optional(),
  startDate: z.string().optional().or(z.literal('')),
  endDate: z.string().optional().or(z.literal('')),
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().optional().default(20),
  includeUnpaid: z.enum(['true', 'false']).optional(),
  saleType: z.string().optional().or(z.literal(''))
}).superRefine((query, context) => {
  for (const field of ['startDate', 'endDate'] as const) {
    const value = query[field];
    if (value && Number.isNaN(Date.parse(value))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} must be a valid date/time`,
      });
    }
  }
});
