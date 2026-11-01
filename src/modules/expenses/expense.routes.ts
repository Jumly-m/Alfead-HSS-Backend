import { Hono } from 'hono';
import { expenseController } from './expense.controller.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { requireActiveSubscription } from '../../middleware/subscription.middleware.js';
import { requirePermission, requireAnyPermission } from '../../middleware/rbac.middleware.js';

const router = new Hono();

router.post('/', 
  authMiddleware,
  requirePermission('expense:create'),
  requireActiveSubscription,
  expenseController.create
);

router.get('/', 
  authMiddleware,
  requirePermission('expense:read'),
  expenseController.getAll
);

router.get('/categories', 
  authMiddleware,
  // Sellers granted only expense:create still need the category list to pick
  // a category when recording an expense.
  requireAnyPermission('expense:read', 'expense:create'),
  expenseController.getCategories
);

router.put('/:id', 
  authMiddleware,
  requirePermission('expense:update'),
  requireActiveSubscription,
  expenseController.update
);

router.delete('/:id', 
  authMiddleware,
  requirePermission('expense:delete'),
  requireActiveSubscription,
  expenseController.delete
);

// Expense Categories Management
router.get('/category-list', 
  authMiddleware,
  requireAnyPermission('expense:read', 'expense:create'),
  expenseController.getCategoryList
);

router.post('/category', 
  authMiddleware,
  // Sellers with expense:create may add their own categories; admins keep the
  // settings:update path. Edit/delete remain admin-only below.
  requireAnyPermission('expense:create', 'settings:update'),
  expenseController.createCategory
);

router.put('/category/:id', 
  authMiddleware,
  requirePermission('settings:update'),
  expenseController.updateCategory
);

router.delete('/category/:id', 
  authMiddleware,
  requirePermission('settings:update'),
  expenseController.deleteCategory
);

export default router;
