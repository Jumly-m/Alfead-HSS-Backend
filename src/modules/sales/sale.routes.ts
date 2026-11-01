import { Hono } from 'hono';
import { saleController } from './sale.controller.js';
import { createSaleSchema, saleQuerySchema, updateSaleSchema } from './sale.schema.js';
import { validateBody } from '../../middleware/validation.middleware.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { requireActiveSubscription } from '../../middleware/subscription.middleware.js';
import { requirePermission } from '../../middleware/rbac.middleware.js';
import { DEBUG_LOGS } from '../../config/index.js';
import { z } from 'zod';

const router = new Hono();

// Validation middleware for query params
const validateQuery = (schema: z.ZodSchema) => {
  return async (c: any, next: any) => {
    try {
      const query: Record<string, any> = c.req.query();
      if (DEBUG_LOGS) console.log('[ValidateQuery] Raw query:', query);
      // Convert empty strings to undefined for optional fields
      Object.keys(query).forEach(key => {
        if (query[key] === '') {
          query[key] = undefined;
        }
      });
      const validated = schema.parse(query);
      if (DEBUG_LOGS) console.log('[ValidateQuery] Validated:', validated);
      c.set('validatedQuery', validated);
      await next();
    } catch (error: any) {
      console.log('[ValidateQuery] Validation error:', error.errors || error.message);
      return c.json({
        success: false,
        error: 'Invalid query parameters',
        details: error.errors || error.message
      }, 400);
    }
  };
};

router.get('/', 
  authMiddleware,
  requirePermission('sale:read'),
  validateQuery(saleQuerySchema),
  saleController.getAll
);

// Analytics routes MUST come before /:id to avoid route collision
router.get('/analytics/overview', 
  authMiddleware,
  requirePermission('sale:read'),
  saleController.getSalesAnalytics
);

router.get('/analytics/customers', 
  authMiddleware,
  requirePermission('sale:read'),
  saleController.getCustomerAnalytics
);

router.get('/analytics/departments', 
  authMiddleware,
  requirePermission('sale:read'),
  saleController.getDepartmentAnalytics
);

router.get('/analytics/products', 
  authMiddleware,
  requirePermission('sale:read'),
  saleController.getProductAnalytics
);

router.get('/:id', 
  authMiddleware,
  requirePermission('sale:read'),
  saleController.getById
);

router.post('/', 
  authMiddleware,
  requirePermission('sale:create'),
  requireActiveSubscription,
  validateBody(createSaleSchema),
  saleController.create
);

router.get('/invoice/:id', 
  authMiddleware,
  requirePermission('sale:read'),
  saleController.getInvoice
);

router.post('/invoice', 
  authMiddleware,
  requirePermission('sale:create'),
  requireActiveSubscription,
  saleController.createInvoice
);

// Payment tracking
router.post('/:id/payments', 
  authMiddleware,
  requirePermission('sale:update'),
  saleController.recordPayment
);

router.get('/:id/payments', 
  authMiddleware,
  requirePermission('sale:read'),
  saleController.getInvoicePayments
);

router.put('/:id/payment-status', 
  authMiddleware,
  requirePermission('sale:update'),
  saleController.updatePaymentStatus
);

router.delete('/:id',
  authMiddleware,
  requirePermission('sale:delete'),
  saleController.deleteInvoice
);

router.put('/:id',
  authMiddleware,
  requirePermission('sale:update'),
  validateBody(updateSaleSchema),
  saleController.update
);

export default router;
