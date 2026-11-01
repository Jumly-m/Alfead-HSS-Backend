import { Hono } from 'hono';
import { productController } from './product.controller.js';
import { createProductSchema, updateProductSchema, addCargoSchema, productQuerySchema } from './product.schema.js';
import { validateBody } from '../../middleware/validation.middleware.js';
import { validateUUID } from '../../middleware/validateUUID.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { requireActiveSubscription } from '../../middleware/subscription.middleware.js';
import { requirePermission } from '../../middleware/rbac.middleware.js';
import { z } from 'zod';

const router = new Hono();

// Validation middleware for query params
const validateQuery = (schema: z.ZodSchema) => {
  return async (c: any, next: any) => {
    try {
      const query: Record<string, any> = c.req.query();
      // Convert empty strings to undefined for optional fields
      Object.keys(query).forEach(key => {
        if (query[key] === '') {
          query[key] = undefined;
        }
      });
      const validated = schema.parse(query);
      c.set('validatedQuery', validated);
      await next();
    } catch (error: any) {
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
  validateQuery(productQuerySchema),
  requirePermission('product:read'),
  productController.getAll
);

router.get('/barcode/:barcode', 
  authMiddleware,
  requirePermission('product:read'),
  productController.getByBarcode
);

// Incremental sync for the POS local product index. Registered BEFORE /:id so
// "sync" is never parsed as a product id.
router.get('/sync',
  authMiddleware,
  requirePermission('product:read'),
  productController.sync
);

router.get('/:id', 
  authMiddleware,
  requirePermission('product:read'),
  productController.getById
);

router.post('/', 
  authMiddleware,
  requirePermission('product:create'),
  requireActiveSubscription,
  validateBody(createProductSchema),
  productController.create
);

router.put('/:id', 
  authMiddleware,
  requirePermission('product:update'),
  requireActiveSubscription,
  validateUUID('id'),
  validateBody(updateProductSchema),
  productController.update
);

router.delete('/:id', 
  authMiddleware,
  requirePermission('product:delete'),
  requireActiveSubscription,
  validateUUID('id'),
  productController.delete
);

router.post('/bulk-delete',
  authMiddleware,
  requirePermission('product:delete'),
  requireActiveSubscription,
  productController.bulkDelete
);

router.post('/:id/cargo', 
  authMiddleware,
  requirePermission('inventory:manage'),
  requireActiveSubscription,
  validateBody(addCargoSchema),
  productController.addCargo
);

router.post('/import', 
  authMiddleware,
  requirePermission('product:create'),
  requireActiveSubscription,
  productController.importProducts
);

export default router;
