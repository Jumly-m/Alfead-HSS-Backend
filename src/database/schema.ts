import { boolean, date, decimal, foreignKey, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Enums
export const userRoleEnum = pgEnum('user_role', ['owner', 'admin', 'seller']);
export const paymentMethodEnum = pgEnum('payment_method', ['cash', 'lipa_namba', 'debt', 'credit', 'bank']);
export const debtStatusEnum = pgEnum('debt_status', ['unpaid', 'partial', 'paid']);
export const subscriptionStatusEnum = pgEnum('subscription_status', ['active', 'expired', 'pending', 'cancelled']);
export const subPaymentStatusEnum = pgEnum('sub_payment_status', ['pending', 'completed', 'failed']);

// Tenants Table
export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 100 }).notNull().unique(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  phone: varchar('phone', { length: 20 }),
  address: text('address'),
  isActive: boolean('is_active').default(true),
  planType: varchar('plan_type', { length: 50 }).default('basic'),
  subscriptionEnabled: boolean('subscription_enabled').default(true),
  subscriptionRequired: boolean('subscription_required').default(true),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Users Table (Better Auth uses VARCHAR for id)
export const users = pgTable('user', {
  id: varchar('id', { length: 255 }).primaryKey(),
  tenantId: varchar('tenant_id', { length: 255 }),
  email: varchar('email', { length: 255 }).notNull(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  firstName: varchar('first_name', { length: 100 }),
  lastName: varchar('last_name', { length: 100 }),
  phone: varchar('phone', { length: 20 }),
  role: varchar('role', { length: 50 }).default('user'),
  isActive: boolean('is_active').default(true),
  emailVerified: boolean('email_verified').default(false),
  lastLoginAt: timestamp('last_login_at'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
  shopId: varchar('shop_id', { length: 255 }),
  banned: boolean('banned').default(false),
  banReason: text('ban_reason'),
  banExpires: timestamp('ban_expires'),
  image: text('image'),
}, (table) => ({
  emailIdx: index('users_email_idx').on(table.email),
}));

// Shops Table
export const shops = pgTable('shops', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  code: varchar('code', { length: 50 }),
  description: text('description'),
  address: text('address'),
  phone: varchar('phone', { length: 20 }),
  email: varchar('email', { length: 255 }),
  isSuperAdmin: boolean('is_super_admin').default(false),
  businessName: varchar('business_name', { length: 255 }),
  branchName: varchar('branch_name', { length: 255 }),
  serialNumber: varchar('serial_number', { length: 50 }),
  logo: text('logo'),
  invoiceFooter: text('invoice_footer'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => ({
  tenantIdIdx: index('shops_tenant_id_idx').on(table.tenantId),
}));

// User Shop Access Table
export const userShopAccess = pgTable('user_shop_access', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  shopId: uuid('shop_id').notNull().references(() => shops.id, { onDelete: 'cascade' }),
  canCreateSales: boolean('can_create_sales').default(true),
  canViewReports: boolean('can_view_reports').default(false),
  canManageInventory: boolean('can_manage_inventory').default(false),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => ({
  userShopIdx: uniqueIndex('user_shop_idx').on(table.userId, table.shopId),
}));

// Categories Table
export const categories = pgTable('categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  shopId: uuid('shop_id').notNull().references(() => shops.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description'),
  color: varchar('color', { length: 7 }),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => ({
  shopNameIdx: uniqueIndex('shop_category_name_idx').on(table.shopId, table.name),
}));

// Products Table
export const products = pgTable('products', {
  id: uuid('id').primaryKey().defaultRandom(),
  shopId: uuid('shop_id').notNull().references(() => shops.id, { onDelete: 'cascade' }),
  categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  sku: varchar('sku', { length: 100 }).notNull(),
  barcode: varchar('barcode', { length: 100 }),
  qrCode: varchar('qr_code', { length: 100 }),
  buyingPrice: decimal('buying_price', { precision: 12, scale: 2 }).notNull().default('0'),
  sellingPrice: decimal('selling_price', { precision: 12, scale: 2 }).notNull().default('0'),
  currentStock: decimal('current_stock', { precision: 12, scale: 4 }).notNull().default('0'),
  lowStockThreshold: decimal('low_stock_threshold', { precision: 12, scale: 4 }).default('10'),
  enableFractions: boolean('enable_fractions').default(false),
  fractionTypes: jsonb('fraction_types').default('[]'),
  fractionPrices: jsonb('fraction_prices').default('{}'),
  expiryDate: timestamp('expiry_date'),
  images: text('images').array(),
  isActive: boolean('is_active').default(true),
  createdBy: text('created_by'),
  costPerQty: decimal('cost_per_qty', { precision: 12, scale: 4 }).default('1'),
  costPerQtyPrice: decimal('cost_per_qty_price', { precision: 12, scale: 2 }).default('0'),
  costPerQtyBuyPrice: decimal('cost_per_qty_buy_price', { precision: 12, scale: 2 }).default('0'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => ({
  shopSkuIdx: uniqueIndex('shop_sku_idx').on(table.shopId, table.sku),
  shopBarcodeIdx: uniqueIndex('shop_barcode_idx').on(table.shopId, table.barcode),
  shopIdIdx: index('products_shop_id_idx').on(table.shopId),
  barcodeIdx: index('products_barcode_idx').on(table.barcode),
  categoryIdIdx: index('products_category_id_idx').on(table.categoryId),
  activeIdx: index('products_active_idx').on(table.isActive).where(sql`${table.isActive} = true`),
  shopActiveNameIdx: index('products_shop_active_name_idx').on(table.shopId, table.isActive, table.name),
}));

// Cargo Entries Table (Stock Batches)
export const cargoEntries = pgTable('cargo_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  quantity: decimal('quantity', { precision: 12, scale: 4 }).notNull(),
  buyingPricePerUnit: decimal('buying_price_per_unit', { precision: 12, scale: 2 }).notNull(),
  transportCost: decimal('transport_cost', { precision: 12, scale: 2 }).default('0'),
  supplierName: varchar('supplier_name', { length: 255 }),
  supplierContact: varchar('supplier_contact', { length: 100 }),
  notes: text('notes'),
  createdBy: text('created_by'),
  entryDate: timestamp('entry_date').defaultNow(),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => ({
  productIdIdx: index('cargo_product_id_idx').on(table.productId),
}));

// Sales Table
export const sales = pgTable('sales', {
  id: uuid('id').primaryKey().defaultRandom(),
  shopId: uuid('shop_id').notNull().references(() => shops.id, { onDelete: 'cascade' }),
  sellerId: text('seller_id').notNull(),
  offlineId: varchar('offline_id', { length: 255 }),
  totalAmount: decimal('total_amount', { precision: 12, scale: 2 }).notNull(),
  paymentMethod: paymentMethodEnum('payment_method').notNull(),
  amountPaid: decimal('amount_paid', { precision: 12, scale: 2 }).notNull().default('0'),
  changeDue: decimal('change_due', { precision: 12, scale: 2 }).notNull().default('0'),
  discountAmount: decimal('discount_amount', { precision: 12, scale: 2 }).default('0'),
  customerName: varchar('customer_name', { length: 255 }),
  customerPhone: varchar('customer_phone', { length: 20 }),
    customerEmail: varchar('customer_email', { length: 255 }),
    customerAddress: text('customer_address'),
    customerTin: varchar('customer_tin', { length: 50 }),
    customerVrn: varchar('customer_vrn', { length: 50 }),
    invoiceSent: boolean('invoice_sent').default(false),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
  verificationCode: varchar('verification_code', { length: 100 }),
  dueDate: date('due_date'),
  paymentReference: varchar('payment_reference', { length: 255 }),
  bankName: varchar('bank_name', { length: 100 }),
}, (table) => ({
  shopIdIdx: index('sales_shop_id_idx').on(table.shopId),
  sellerIdIdx: index('sales_seller_id_idx').on(table.sellerId),
  createdAtIdx: index('sales_created_at_idx').on(table.createdAt),
  shopCreatedAtIdx: index('sales_shop_created_at_idx').on(table.shopId, table.createdAt),
}));

// Sale Items Table
export const saleItems = pgTable('sale_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  saleId: uuid('sale_id').notNull().references(() => sales.id, { onDelete: 'cascade' }),
  productId: uuid('product_id').notNull().references(() => products.id),
  cargoEntryId: uuid('cargo_entry_id').references(() => cargoEntries.id),
  productName: varchar('product_name', { length: 255 }).notNull(),
  quantity: decimal('quantity', { precision: 12, scale: 4 }).notNull(),
  fractionType: varchar('fraction_type', { length: 20 }).default('whole'),
  unitPrice: decimal('unit_price', { precision: 12, scale: 2 }).notNull(),
  discount: decimal('discount', { precision: 12, scale: 2 }).default('0'),
  buyingPriceAtSale: decimal('buying_price_at_sale', { precision: 12, scale: 2 }).notNull(),
  totalPrice: decimal('total_price', { precision: 12, scale: 2 }).notNull(),
  profit: decimal('profit', { precision: 12, scale: 2 }).default('0'),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => ({
  saleIdIdx: index('sale_items_sale_id_idx').on(table.saleId),
  productIdIdx: index('sale_items_product_id_idx').on(table.productId),
  cargoEntryIdIdx: index('sale_items_cargo_entry_id_idx').on(table.cargoEntryId),
  saleProductIdIdx: index('sale_items_sale_product_idx').on(table.saleId, table.productId),
}));

// Debtors Table
export const debtors = pgTable('debtors', {
  id: uuid('id').primaryKey().defaultRandom(),
  shopId: uuid('shop_id').notNull().references(() => shops.id, { onDelete: 'cascade' }),
  saleId: uuid('sale_id').references(() => sales.id),
  name: varchar('customer_name', { length: 255 }),
  phone: varchar('customer_phone', { length: 20 }),
  email: varchar('customer_email', { length: 255 }),
  totalAmount: decimal('total_amount', { precision: 12, scale: 2 }).notNull(),
  paidAmount: decimal('paid_amount', { precision: 12, scale: 2 }).default('0'),
  dueDate: timestamp('due_date'),
  status: debtStatusEnum('status').default('unpaid'),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => ({
  shopIdIdx: index('debtors_shop_id_idx').on(table.shopId),
  statusIdx: index('debtors_status_idx').on(table.status),
  saleIdIdx: index('debtors_sale_id_idx').on(table.saleId),
}));

// Debt Items Table
export const debtItems = pgTable('debt_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  debtorId: uuid('debtor_id').notNull().references(() => debtors.id, { onDelete: 'cascade' }),
  productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),
  productName: varchar('product_name', { length: 255 }).notNull(),
  quantity: decimal('quantity', { precision: 12, scale: 3 }).notNull().default('1'),
  unitPrice: decimal('unit_price', { precision: 12, scale: 2 }).notNull().default('0'),
  discount: decimal('discount', { precision: 12, scale: 2 }).default('0'),
  totalPrice: decimal('total_price', { precision: 12, scale: 2 }).notNull().default('0'),
  buyingPrice: decimal('buying_price', { precision: 12, scale: 2 }).default('0'),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => ({
  debtorIdIdx: index('debt_items_debtor_id_idx').on(table.debtorId),
}));

// Debt Payments Table
export const debtPayments = pgTable('debt_payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  debtorId: uuid('debtor_id').notNull().references(() => debtors.id, { onDelete: 'cascade' }),
  amount: decimal('amount', { precision: 12, scale: 2 }).notNull(),
  paymentMethod: varchar('payment_method', { length: 20 }).notNull(),
  receivedBy: text('received_by'),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => ({
  debtorIdIdx: index('debt_payments_debtor_id_idx').on(table.debtorId),
  debtorCreatedIdx: index('debt_payments_debtor_created_idx').on(table.debtorId, table.createdAt),
}));

// Expenses Table
export const expenses = pgTable('expenses', {
  id: uuid('id').primaryKey().defaultRandom(),
  shopId: uuid('shop_id').notNull().references(() => shops.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  category: varchar('category', { length: 100 }).notNull(),
  description: text('description'),
  amount: decimal('amount', { precision: 12, scale: 2 }).notNull(),
  date: date('date').notNull(),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => ({
  shopIdIdx: index('expenses_shop_id_idx').on(table.shopId),
  dateIdx: index('expenses_date_idx').on(table.date),
  shopDateIdx: index('expenses_shop_date_idx').on(table.shopId, table.date),
}));

// Pre-orders/Advance Payments Table
export const preOrders = pgTable('pre_orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  shopId: uuid('shop_id').notNull().references(() => shops.id, { onDelete: 'cascade' }),
  customerName: varchar('customer_name', { length: 255 }).notNull(),
  customerPhone: varchar('customer_phone', { length: 20 }).notNull(),
  customerEmail: varchar('customer_email', { length: 255 }),
  totalAmount: decimal('total_amount', { precision: 12, scale: 2 }).notNull(),
  paidAmount: decimal('paid_amount', { precision: 12, scale: 2 }).default('0'),
  status: varchar('status', { length: 20 }).default('pending'),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
  productName: varchar('product_name', { length: 255 }),
  productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),
  quantity: integer('quantity').default(1),
}, (table) => ({
  shopIdIdx: index('pre_orders_shop_id_idx').on(table.shopId),
  statusIdx: index('pre_orders_status_idx').on(table.status),
  shopCreatedIdx: index('pre_orders_shop_created_idx').on(table.shopId, table.createdAt),
}));

// Pre-order Payments Table
export const preOrderPayments = pgTable('pre_order_payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  preOrderId: uuid('pre_order_id').notNull().references(() => preOrders.id, { onDelete: 'cascade' }),
  amount: decimal('amount', { precision: 12, scale: 2 }).notNull(),
  paymentMethod: varchar('payment_method', { length: 20 }).notNull(),
  receivedBy: text('received_by').notNull(),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => ({
  preOrderIdIdx: index('pre_order_payments_pre_order_id_idx').on(table.preOrderId),
  preOrderCreatedIdx: index('pre_order_payments_order_created_idx').on(table.preOrderId, table.createdAt),
}));

// Audit Logs Table
export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id),
  action: varchar('action', { length: 50 }).notNull(),
  entityType: varchar('entity_type', { length: 50 }).notNull(),
  entityId: uuid('entity_id'),
  oldValues: text('old_values'),
  newValues: text('new_values'),
  ipAddress: varchar('ip_address', { length: 45 }),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => ({
  tenantIdIdx: index('audit_tenant_id_idx').on(table.tenantId),
  userIdIdx: index('audit_user_id_idx').on(table.userId),
  actionIdx: index('audit_action_idx').on(table.action),
}));

// Sync Queue Table
export const syncQueue = pgTable('sync_queue', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  shopId: uuid('shop_id').notNull().references(() => shops.id, { onDelete: 'cascade' }),
  deviceId: varchar('device_id', { length: 255 }).notNull(),
  operationType: varchar('operation_type', { length: 50 }).notNull(),
  entityType: varchar('entity_type', { length: 50 }).notNull(),
  offlineId: varchar('offline_id', { length: 255 }).notNull(),
  payload: text('payload').notNull(),
  status: varchar('status', { length: 20 }).default('pending'),
  retryCount: integer('retry_count').default(0),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at').defaultNow(),
  processedAt: timestamp('processed_at'),
}, (table) => ({
  tenantIdIdx: index('sync_queue_tenant_id_idx').on(table.tenantId),
  statusIdx: index('sync_queue_status_idx').on(table.status),
}));

// Backup Settings Table
export const backupSettings = pgTable('backup_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: text('tenant_id'),
  shopId: text('shop_id'),
  backupType: varchar('backup_type', { length: 20 }).notNull().default('full'), // full, shop
  backupLocation: text('backup_location'), // local path or custom
  customPath: text('custom_path'), // custom backup path if set
  frequency: varchar('frequency', { length: 20 }).notNull().default('weekly'), // daily, weekly, monthly
  retentionDays: integer('retention_days').notNull().default(30), // keep backups for X days
  isEnabled: boolean('is_enabled').default(true),
  lastBackupAt: timestamp('last_backup_at'),
  nextBackupAt: timestamp('next_backup_at'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Backup History Table
export const backupHistory = pgTable('backup_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: text('tenant_id'),
  shopId: text('shop_id'),
  filename: varchar('filename', { length: 255 }).notNull(),
  filepath: text('filepath').notNull(),
  filesize: integer('filesize'), // in bytes
  backupType: varchar('backup_type', { length: 20 }).notNull().default('full'),
  status: varchar('status', { length: 20 }).notNull().default('pending'), // pending, completed, failed
  errorMessage: text('error_message'),
  startedAt: timestamp('started_at').defaultNow(),
  completedAt: timestamp('completed_at'),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => ({
  tenantIdIdx: index('backup_history_tenant_id_idx').on(table.tenantId),
  shopIdIdx: index('backup_history_shop_id_idx').on(table.shopId),
  statusIdx: index('backup_history_status_idx').on(table.status),
}));

// subscription_plans — multi-period billing plans with discounts
export const subscriptionPlans = pgTable('subscription_plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 100 }).notNull(),
  priceTzs: integer('price_tzs').notNull(), // final billed amount after discount
  fullPriceTzs: integer('full_price_tzs').notNull(), // pre-discount (UI strike-through)
  discountPercent: integer('discount_percent').notNull().default(0), // 0 | 10 | 20 | 33
  durationDays: integer('duration_days').notNull().default(30), // 30 | 90 | 180 | 365
  maxShops: integer('max_shops'), // null = unlimited
  maxSellers: integer('max_sellers'), // null = unlimited
  description: text('description'), // plan description for paywall UI
  badge: varchar('badge', { length: 50 }), // e.g. 'Best Value'
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at').defaultNow(),
});

// tenant_subscriptions — subscription records per tenant
export const tenantSubscriptions = pgTable('tenant_subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  planId: uuid('plan_id').notNull().references(() => subscriptionPlans.id),
  status: subscriptionStatusEnum('status').notNull().default('pending'), // active | expired | pending | cancelled
  currentPeriodStart: timestamp('current_period_start'),
  currentPeriodEnd: timestamp('current_period_end'),
  snippeReference: varchar('snippe_reference', { length: 255 }),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => ({
  tenantIdIdx: index('sub_tenant_id_idx').on(table.tenantId),
  statusIdx: index('sub_status_idx').on(table.status),
  tenantStatusPeriodIdx: index('sub_tenant_status_period_idx').on(table.tenantId, table.status, table.currentPeriodEnd),
  planIdIdx: index('sub_plan_id_idx').on(table.planId),
}));

// subscription_payments — Snippe payment records
export const subscriptionPayments = pgTable('subscription_payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  subscriptionId: uuid('subscription_id').notNull().references(() => tenantSubscriptions.id),
  snippeReference: varchar('snippe_reference', { length: 255 }).notNull().unique(),
  snippeEventId: varchar('snippe_event_id', { length: 255 }).unique(), // for webhook deduplication
  amountTzs: integer('amount_tzs').notNull(),
  status: subPaymentStatusEnum('status').notNull().default('pending'), // pending | completed | failed
  paymentChannel: varchar('payment_channel', { length: 50 }), // mpesa | airtel | tigopesa | halotel | card | qr
  paymentType: varchar('payment_type', { length: 20 }), // mobile | card | dynamic-qr
  customerPhone: varchar('customer_phone', { length: 20 }),
  metadata: text('metadata'), // JSON string
  paidAt: timestamp('paid_at'),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => ({
  tenantIdIdx: index('subpay_tenant_id_idx').on(table.tenantId),
  refIdx: index('subpay_ref_idx').on(table.snippeReference),
  subscriptionIdIdx: index('subpay_subscription_id_idx').on(table.subscriptionId),
}));

// admin_audit_log — Super admin action audit trail
export const adminAuditLog = pgTable('admin_audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  adminId: uuid('admin_id').notNull().references(() => users.id),
  action: varchar('action', { length: 100 }).notNull(), // force_activate | cancel_subscription | view_tenant
  targetTenantId: uuid('target_tenant_id'),
  targetSubscriptionId: uuid('target_subscription_id'),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow(),
});
