import { Hono } from 'hono';
import { pool } from '../../config/drizzle.js';
import { isDisposableEmail } from '../../utils/disposable-email.js';

const router = new Hono();

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:47831';

// ─── Public AI chat rate limit ───────────────────────────────────────────────
// The public landing chat calls a paid AI provider without authentication.
// Cap it per IP so it can't be abused to burn API credits.
const publicChatHits = new Map<string, { count: number; resetAt: number }>();
const PUBLIC_CHAT_WINDOW_MS = 10 * 60 * 1000;
const PUBLIC_CHAT_MAX = 20;

function checkPublicChatRateLimit(c: any): boolean {
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'unknown';
  const now = Date.now();
  const entry = publicChatHits.get(ip);
  if (!entry || now > entry.resetAt) {
    publicChatHits.set(ip, { count: 1, resetAt: now + PUBLIC_CHAT_WINDOW_MS });
    if (publicChatHits.size > 5000) {
      for (const [k, v] of publicChatHits) if (Date.now() > v.resetAt) publicChatHits.delete(k);
    }
    return true;
  }
  if (entry.count >= PUBLIC_CHAT_MAX) return false;
  entry.count += 1;
  return true;
}

const SYSTEM_KNOWLEDGE = `SYSTEM OVERVIEW:
ALFEAN ENTERPRISES is a complete smart business management system built specifically for shops and businesses in Tanzania. It works both online and offline as a PWA (Progressive Web App). The system is multi-tenant (each tenant can have multiple shops), role-based (Developer, Admin/Owner, Seller). There is NO subscription payment — the system is free to use; the only paid service is SMS credits, bought inside the app via M-Pesa through the Snippe payment gateway.

TECHNICAL ARCHITECTURE:
- Backend: Node.js with Hono framework (lightweight, fast), TypeScript
- Database: PostgreSQL with Drizzle ORM
- Frontend: React 18 + Vite + TailwindCSS
- State Management: Zustand + React Query
- Authentication: Better Auth with JWT tokens (access + refresh)
- Email: Resend API for transactional emails (welcome, receipts, reminders, marketing)
- AI Integration: DeepSeek API for email content generation
- Payment Gateway: Snippe (Tanzania) for M-Pesa, Airtel Money, Tigo Pesa, HaloTel, Card, QR
- Real-time: Server-Sent Events (SSE) for live chat
- File Storage: Local filesystem with cloud backup option
- Cron Jobs: Automatic subscription expiry checks, daily marketing emails, backup scheduling

========== CORE FEATURES (DETAILED) ==========

1. POINT OF SALE (POS) SYSTEM:
   The POS is the core transaction engine. It supports:
   
   a) Product Selection:
      - Barcode scanning using device camera or USB barcode scanner — instant product lookup
      - Full-text search across all products by name, SKU, or barcode
      - Quick-add from product grid with categories and search filter
      - Recent/favorite products for fast reordering
   
   b) Cart Management:
      - Add/remove items, adjust quantities (whole or fractional)
      - Apply per-item or global discounts (percentage or fixed amount)
      - Support for fractional quantities: 0.5 KG, 1.75 MTR, 2.25 SQM
      - Dimension-based selling: enter length × width for glass, tiles, aluminium, automatically calculates total price
      - Multi-unit pricing: choose between PCS, KG, MTR, SQM at checkout with different prices per unit
      - Quick fraction buttons: Whole (1), Half (0.5), Quarter (0.25), Third (0.33) for fast entry
      - View itemized list with unit price, quantity, discount, and line total
   
   c) Payment Processing:
      - Cash: enter amount tendered, system calculates change automatically
      - Lipa Namba (M-Pesa): enter customer phone number, shows payment prompt
      - Bank Transfer: record bank name and reference
      - Debt/Credit Sale: record as a customer debt with optional due date
      - Mixed payments: split between cash and mobile money
   
   d) Receipt & Invoice:
      - Auto-generates receipt on every completed sale
      - Thermal printer support (80mm) with browser-based printing
      - Option to email receipt to customer
      - Custom receipt footer with shop business details
   
   e) Offline Sales:
      - Sales recorded locally when offline
      - Auto-syncs to server when internet reconnects
      - Unique offline IDs prevent duplicate entries

2. PRODUCT & INVENTORY MANAGEMENT:
   Complete product lifecycle management:
   
   a) Product Creation:
      - Fields: name, description, category, brand, barcode, SKU, buying price, selling price
      - Stock: current stock, low stock threshold, enable fractions
      - Units: primary unit (PCS, KG, MTR, SQM, LTR, ROLL, BOX, PKG, SET, TON, FT, YARD)
      - Multi-unit pricing with conversion factors (e.g., 1 BOX = 12 PCS, separate prices per unit)
      - Cost-per-quantity pricing (e.g., price per meter when selling by length)
      - Expiry date tracking for perishable items
      - Product images (multiple)
      - QR code generation for each product
   
   b) Categories:
      - Custom categories with color coding: Glass, Aluminium, Cement, Paint, Pipes, Tiles, Electrical, Plumbing, Tools, Roofing, Timber, Plumbing Fittings, Steel Bars, Nails & Screws, etc.
      - Products can belong to one category
      - Category-based filtering in POS and reports
   
   c) Stock Management:
      - Real-time stock levels update automatically on every sale
      - Low stock alerts with configurable threshold per product
      - Stock value calculation (buying price × current stock)
      - Manual stock adjustments with reason tracking
      - Stock history: view all stock changes with timestamps and user
      - Cargo/shipment entries: track incoming stock with supplier, buying price, transport costs
   
   d) Barcode:
      - Auto-generate barcodes using JsBarcode library
      - Print barcode labels individually or in batch
      - Custom barcode entry for existing barcodes
      - Camera barcode scanning on mobile devices via html5-qrcode
   
   e) Import/Export:
      - Bulk import products via CSV/Excel file
      - Export product list to Excel with all fields
      - Duplicate products for quick creation of similar items

3. CUSTOMER MANAGEMENT:
   a) Customer Records:
      - Store: name, phone, email, company, address
      - Auto-capture from sales transactions
      - Manual create/edit with full details
   
   b) Purchase History:
      - Complete transaction history per customer
      - Total spent, order count, average order value
      - Last purchase date
      - Customer since date
   
   c) Debt Tracking per Customer:
      - Outstanding balance visible on customer profile
      - Payment history with dates, amounts, methods
      - Per-customer credit limits
      - Overdue alerts for debts past due date
   
   d) Analytics:
      - Top customers by revenue
      - Most frequent buyers
      - Customer segmentation by purchase behavior
   
   e) Walk-in Customer:
      - Default "Walk-in Customer" for quick sales without registration
      - Track as anonymous transactions

4. DEBT TRACKING & MANAGEMENT:
   Comprehensive accounts receivable system:
   
   a) Recording Debts:
      - Create debt from POS sale (debt sale option)
      - Manual debt entry for existing balances
      - Attach sale items, product details, quantities, prices
      - Set due date for payment
      - Notes and description
   
   b) Payment Collection:
      - Record partial payments anytime
      - Full payment marks debt as paid
      - Multiple payment methods for debt settlement (cash, M-Pesa, bank)
      - Payment history with recorded-by tracking
      - Automatic balance recalculation after each payment
   
   c) Debt Reporting:
      - Total outstanding debts across all customers
      - Debt aging: overdue by 7 days, 30 days, 60+ days
      - Per-customer balance summary
      - Payment collection history
      - Export debt reports to PDF or Excel
   
   d) Debtor Communication:
      - Call debtor directly from the app (click-to-call)
      - Print debt receipts for customers
      - Color-coded status: unpaid (red), partial (amber), paid (green)

5. SALES TRACKING & PROFIT ANALYSIS:
   a) Sale Recording:
      - Every transaction recorded with: date, time, items, quantities, unit prices, discounts
      - Payment method tracking (cash, M-Pesa, bank, debt)
      - Seller identification (who made the sale)
      - Offline ID for synced transactions
   
   b) Profit Calculation:
      - Automatic profit per sale (selling price - buying price)
      - Gross profit = total revenue - cost of goods sold
      - Net earnings = gross profit - expenses
      - Profit margins per product and per sale
      - Buying price at time of sale preserves historical cost data
   
   c) Sales Reports:
      - Daily sales summary: revenue, profit, transaction count
      - Monthly and yearly comparisons
      - Sales by payment method breakdown
      - Sales by product (best sellers)
      - Sales by category
      - Sales by seller/employee
      - Period-over-period comparison (today vs yesterday, this month vs last month)
   
   d) Invoice Management:
      - Invoice types: normal sale, credit invoice (debt), proforma
      - Track invoice payment status: unpaid, partial, paid
      - Invoice payments: record partial payments against invoices
      - Email invoice as PDF to customers
      - Custom invoice footer with business details
      - Professional PDF generation with jsPDF and autoTable
      - Sequential invoice numbering
      - Shop logo on invoices

6. EXPENSE TRACKING:
   a) Expense Categories:
      - Predefined: Rent, Utilities (Electricity/Water/Internet), Salaries, Supplies, Transport, Maintenance, Marketing, Insurance, Taxes, Other
      - Custom category creation by shop
      - Category descriptions for clarity
   
   b) Expense Recording:
      - Amount, date, category, description
      - Worker breakdown for salary/wage expenses (multiple workers, individual amounts)
      - Payee name (paid to whom)
      - Period tracking (start/end date for recurring expenses)
      - Tenant and shop association
   
   c) Expense Reporting:
      - Total expenses over any date range
      - Breakdown by category (pie/bar charts)
      - Expense trends over time
      - Expense vs profit comparison
      - Expense-to-revenue ratio analysis
   
   d) Worker Management:
      - Track individual workers and their wages
      - Per-worker expense breakdown within salary entries
      - History of payments to each worker

7. REPORTS & ANALYTICS DASHBOARD:
   a) Main Dashboard:
      - 7 metric cards: Today's Sales, Today's Profit, Today's Orders, Total Revenue, Total Products, Stock Value, Total Debt
      - Recent transactions table
      - Low stock alerts
      - Quick action buttons
   
   b) Analytics Module:
      - Sales over time charts (line chart with Recharts)
      - Revenue and profit trends
      - Payment method distribution (pie/donut chart)
      - Top selling products (bar chart)
      - Sales by category
      - Monthly comparisons
      - Shop performance comparison (multi-shop)
      - Date range filter with presets (Today, This Week, This Month, This Year, Custom)
   
   c) Export Options:
      - Export any report as PDF (with charts)
      - Export as Excel (.xlsx with xlsx library)
      - Print directly from browser
   
   d) Shop-Specific Reports:
      - Per-shop sales and profit reports
      - Per-shop expense reports
      - Consolidated reports across all shops (for multi-shop)

8. INVENTORY (STOCK TAKE):
   Physical inventory counting and reconciliation:
   
   a) Stock Take Sessions:
      - Create named sessions (e.g., "Monthly Count March 2024")
      - Track start time, end time, status (in-progress, completed, approved)
      - Who started and who approved the count
      - Notes and observations
   
   b) Counting Process:
      - Shows system quantity for each product
      - Enter physical count quantity
      - System calculates difference automatically
      - Products can be counted in any order
      - Progress tracking (X of Y products counted)
      - Filter by counted/uncounted status
   
   c) Reconciliation:
      - View all discrepancies (shortages and excesses)
      - Financial impact of each discrepancy
      - Individual product adjustment or batch approve
      - Stock adjustments created automatically on approval
   
   d) Sales During Stock Take:
      - Tracks sales that occur during the counting process
      - Accounts for sales when reconciling differences
      - Ensures accurate stock adjustment calculations
   
   e) Export:
      - Export stock take results as CSV/Excel
      - Printable stock take sheets for physical counting

9. PRE-ORDERS MANAGEMENT:
   a) Pre-order Creation:
      - Customer details: name, phone, email
      - Product details: product name, quantity, link to product catalog
      - Multiple items per pre-order with items_data JSON support
      - Total amount and paid amount tracking
      - Expected arrival/delivery date
      - Notes and special instructions
      - Link to future sale record
   
   b) Payment Tracking:
      - Record payments/deposits against pre-orders
      - Payment history with method and amount
      - Balance remaining calculation
   
   c) Status Workflow:
      - Pending → Partially Paid → Completed → Cancelled
      - Status updates with timestamps
      - Filter by status
   
   d) Fulfillment:
      - When stock arrives, mark as fulfilled
      - Optional conversion to actual sale record
      - Notification to customer

10. UNIT & MEASUREMENT MANAGEMENT:
    a) Available Units:
       - PCS (Pieces), KG (Kilograms), MTR (Meters), SQM (Square Meters), LTR (Liters)
       - ROLL, BOX, PKG (Package), SET, TON (Tons), FT (Feet), YARD
       - Custom units can be defined per shop
       - Unit symbols and descriptions
       - Base unit conversion (e.g., 1 BOX = 12 PCS)
   
    b) Fractional Selling:
       - Enable/disable fractions per product
       - Fraction types: whole, half (½), quarter (¼), third (⅓)
       - Custom fraction prices per type
       - Decimal quantity entry (e.g., 2.5 KG, 1.75 MTR)
       - Stock tracking in decimal quantities
   
    c) Dimension-Based Selling:
       - Enter length and width at POS
       - Auto-calculates area (length × width)
       - Unit-aware (meters or feet)
       - Common for: glass cutting, tiles, aluminium frames, roofing sheets
       - Price per square meter with automatic total calculation

11. MULTI-SHOP & MULTI-SELLER SUPPORT:
    a) Shop Management:
       - Create unlimited shops/branches
       - Each shop has independent: products, stock, sales, expenses, customers
       - Shop details: name, code, address, phone, email, business name, branch name, serial number
       - Shop logo and invoice footer (custom per shop)
       - Super admin shop flag for system-wide operations
   
    b) User-Shop Assignment:
       - Users can be assigned to multiple shops
       - Role per shop: owner, admin, seller
       - Switch between shops from the main navigation
       - Permissions per user per shop
   
    c) Consolidated Reporting:
       - View reports per shop or all shops combined
       - Compare performance across branches
   
    d) Seller Tracking:
       - Every sale attributed to the seller who processed it
       - Seller performance reports
       - Sales by seller breakdown

12. SUBSCRIPTION & BILLING:
    a) System Feature:
       - Optional subscription enforcement (configurable per tenant)
       - Grace period for expired subscriptions
       - Trial period (configurable, default 30 days)
       - Subscription-required flag per tenant
   
    b) Plans:
       - Custom plan creation (name, price, duration, discounts)
       - Full price and discounted price
       - Discount percentage display
       - Max shops and max sellers limits
       - Plan description and badge
       - Active/inactive toggle
   
    c) Payment Processing:
       - Snippe payment gateway integration (Tanzania)
       - Payment methods: M-Pesa, Airtel Money, Tigo Pesa, HaloTel, Card, QR
       - Payment status tracking (pending, completed, failed)
       - Webhook-based payment confirmation
       - Automatic subscription activation on payment
   
    d) Promotional Offers:
       - Create discount codes and offers
       - Offer types: discount, bonus days
       - Percentage discounts and free bonus days
       - Usage limits and expiry dates
       - Tenant-specific or global offers
   
    e) Billing Dashboard:
       - Payment history with references
       - Invoice/receipt generation
       - Subscription status monitoring
       - Force activation for admin/manual override
       - Audit logging for all billing actions
   
    f) Trial Management:
       - Default trial duration (configurable)
       - Auto-activate free trial on registration
       - Trial status: active, expired, converted to paid
       - Trial conversion rate tracking
       - Admin can reset/extend trials

13. SYSTEM ADMINISTRATION & MONITORING:
    a) Super Admin / Developer Dashboard:
       - Full system overview with key metrics
       - Revenue tracking (total, monthly, MRR)
       - Tenant management (list, filter, toggle subscription)
       - User management (create, edit, ban, delete, role change)
       - Shop management (create, rename, view details)
       - Plan management (CRUD subscription plans)
       - Payment history and management
       - Promotional offers management
       - Activity logs (all system actions)
       - Login history with IP and user agent tracking
       - Security alerts (failed login attempts)
       - Active users (currently logged in with sessions)
       - System health monitoring (DB latency, memory, uptime, table counts)
       - Error logs (system_errors table)
       - Revenue reports (daily revenue, MRR, charts)
       - Support ticket management
       - Audit logs (admin actions)
       - Feature flag management
       - System settings configuration
       - Cloud backup and restore
   
    b) Activity Logging:
       - Every user action logged: login, sale, product changes, user management
       - Fields: user, action, entity type, entity ID, details (JSON), IP, user agent
       - Shop and tenant context preserved
       - Paginated viewing with search
   
    c) Login History:
       - Successful and failed login attempts
       - IP address, user agent, device identification
       - Logout time tracking
       - Failure reason recording
       - Status filtering

14. NOTIFICATIONS SYSTEM:
    a) Types:
       - Low stock alerts
       - New debt / debt reminders
       - Subscription expiry warnings
       - Payment received
       - System updates
       - Support chat messages
   
    b) Delivery:
       - In-app notification center with bell icon
       - Unread count badge
       - Real-time updates
       - Action URL linking
       - Color-coded by type
       - Paginated history
   
    c) Support Chat Notifications:
       - New message alerts
       - Admin joined notification
       - Read receipts (double-check marks)

15. SUPPORT SYSTEM:
    a) Public AI Chat (unauthenticated):
       - DeepSeek AI-powered assistant
       - Answers questions about features, pricing, usage
       - Language support: English and Swahili
       - Contact request form for human follow-up
       - simu link integration
   
    b) Authenticated Live Chat:
       - Real-time messaging with SSE (Server-Sent Events)
       - Admin assignment and response
       - Typing indicators
       - Message read receipts
       - Chat history persistence
       - File/attachment support
       - Email notifications for replies
       - Close/resolve chat functionality
   
    c) Ticket System:
       - Support tickets with status workflow (open → active → closed)
       - Priority levels
       - Admin notes and internal comments
       - Audit trail of all interactions

16. OFFLINE CAPABILITY:
    The system is a Progressive Web App (PWA):
    a) Works completely without internet connection
    b) Caches product catalog, customer data locally
    c) Records sales and transactions offline
    d) Auto-syncs all data when internet connection restores
    e) No data loss — queue-based sync mechanism
    f) Installable on phone/tablet home screen (add to home screen)
    g) Push notification support when online
    h) Faster loading on repeat visits (cached assets)

17. BACKUP SYSTEM:
    a) Automatic Scheduled Backups:
       - Configurable frequency (daily, weekly, monthly)
       - Retention period (configurable days)
       - Full database backup (pg_dump)
       - Local file storage
       - Cloud upload (manual or automatic)
   
    b) Restore:
       - One-click restore from cloud backup
       - Backup URL entry for custom restore
       - Backup history with status tracking
       - Error reporting for failed backups
   
    c) VPS Backup Receiver:
       - Remote backup listener for off-site storage
       - Automatic backup file reception
       - Separate backup receiver service

18. EMAIL SYSTEM (Transactional + Marketing):
    a) Transactional Emails via Resend:
       - Welcome email on registration (Swahili, DeepSeek-generated)
       - Payment receipts and confirmations
       - Subscription activation confirmation
       - Payment failure notifications
       - Subscription expiry reminders (10, 3, 1 day before)
       - Subscription expired notification
       - Free trial started notification
       - Support ticket created/reply notifications
       - Password reset emails
   
    b) Marketing Emails:
       - Daily AI-generated marketing emails (feature highlights)
       - Rotates through 14+ features automatically
       - Generated by DeepSeek API in Swahili
       - Personalized with tenant name
       - Includes simu and Channel CTAs
   
    c) Email Campaigns (Admin):
       - Compose custom email campaigns
       - Audience segments: all tenants, active trials, expired trials, paid active, not activated
       - AI email writer powered by DeepSeek
       - HTML template gallery (blank, welcome, trial_expiring, feature_announcement, promotional, maintenance, re_engagement)
       - Campaign history with stats
       - Test send functionality
       - Variable insertion: {{name}}, {{email}}, {{app_url}}
   
    d) Inbound Email:
       - Receive and reply to emails via Resend webhook
       - Email threading and conversation view
       - Attachment handling
       - Reply from admin dashboard

19. SELLER FEATURES:
    Each seller/employee has:
    - Individual login with role-based permissions
    - Sales attribution (who made each sale)
    - Limited access based on permissions (can view reports, edit products, manage customers, etc.)
    - Permission categories: Products, Sales, POS, Customers, Debts, Expenses, Reports, Settings, Users, Shops
    - Granular toggle per permission per shop

20. SECURITY FEATURES:
    a) Authentication:
       - Password hashing with bcrypt (salt rounds)
       - JWT access + refresh token system
       - Session management with expiry
       - IP address tracking on login
       - Failed attempt tracking
   
    b) Authorization:
       - Role-based access control (RBAC): developer, admin, seller
       - Permission-based system for fine-grained access
       - Shop-scoped permissions
       - Super admin override capability
   
    c) Data Protection:
       - HTTPS encryption for all API traffic
       - Password hashing (never stored in plaintext)
       - Secure HTTP-only cookies for sessions
       - SQL injection protection via parameterized queries
       - Input validation using Zod schemas
   
    d) Audit:
       - Comprehensive activity logging
       - Admin audit log for configuration changes
       - Login history with timestamps and IPs
       - System error capture and logging

========== PRICING & SUBSCRIPTION (TZS) ==========
- Free 30-day trial with FULL access to all features (no credit card required)
- Basic Monthly: TZS 15,000 per month
- 3-Month Plan: TZS 40,500 (save 10%)
- 6-Month Plan: TZS 72,000 (save 20%)
- Annual Plan: TZS 120,000 (save 33% — best value)
- All payments via M-Pesa, Airtel Money, Tigo Pesa, HaloTel, Card, or QR
- Auto-activation on payment confirmation
- Grace period before access restriction on expiry

========== REGISTRATION & ONBOARDING ==========
1. Go to the login page at the app URL
2. Click "Create one" to register
3. Enter: business name, your name, email, phone number, password
4. System automatically creates: tenant account, admin user, first shop
5. 30-day free trial activated immediately
6. Welcome email sent with login instructions and feature overview
7. Log in and start using: add products, make sales, track everything

========== SUPPORT ==========
- App URL: ${APP_URL}`;

async function getLandingContentForChat() {
  try {
    const result = await pool.query(
      `SELECT value FROM system_settings WHERE key = 'landing_content'`
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
  } catch { return null; }
}

router.post('/chat', async (c) => {
  try {
    // Cost/abuse guard: this endpoint calls the paid AI API anonymously.
    // 20 messages per 10 minutes per IP.
    if (!checkPublicChatRateLimit(c)) {
      return c.json({ success: false, error: 'Too many messages. Please try again later.' }, 429);
    }
    const { message, language = 'sw' } = await c.req.json();

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return c.json({ success: false, error: 'Message is required' }, 400);
    }

    const langInstruction = language === 'en'
      ? 'Respond in English. Be professional, detailed, and helpful. Use clear English that a Tanzanian business owner can understand.'
      : 'Jibu kwa Kiswahili. Kuwa wa kitaalamu, maelezo kamili, na msaada. Tumia Kiswahili cha kawaida kinachoeleweka kwa mfanyabiashara wa Tanzania. Mchanganye maneno machache ya Kiingereza yanapotakiwa kama "POS", "barcode", "invoice".';

    const landingContent = await getLandingContentForChat();
    let landingDataStr = '';
    if (landingContent) {
      // Subscription plans are switched off — never feed pricing/plans to the
      // assistant (the marketing landing page no longer exists either). The FAQ,
      // hero and feature highlights are still useful for general questions.
      const faq = landingContent.faq;
      if (faq) {
        landingDataStr += `\n\n======= FAQ FROM SYSTEM =======\n`;
        (faq.items || []).forEach((item: any, idx: number) => {
          landingDataStr += `\nQ${idx + 1}: ${item.q || ''}\nA: ${item.a || ''}\n`;
        });
      }
      if (landingContent.hero) {
        landingDataStr += `\n\n======= HERO =======\n`;
        landingDataStr += `Tagline: ${landingContent.hero.badge || ''}\n`;
        landingDataStr += `Title: ${landingContent.hero.title || ''}\n`;
        landingDataStr += `Subtitle: ${landingContent.hero.subtitle || ''}\n`;
      }
      if (landingContent.features) {
        landingDataStr += `\n\n======= FEATURES HIGHLIGHTS =======\n`;
        landingDataStr += `Badge: ${landingContent.features.badge || ''}\n`;
        landingDataStr += `Title: ${landingContent.features.title || ''}\n`;
        (landingContent.features.items || []).forEach((feat: any, idx: number) => {
          landingDataStr += `\n${idx + 1}. ${feat.title || ''}: ${feat.desc || ''}`;
        });
      }
    }
    const landingBlock = landingDataStr
      ? `\n\n========== LIVE DATA FROM SYSTEM (use these for accurate FAQ answers and system info) ==========\n${landingDataStr}`
      : '';

    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-flash',
        messages: [
          {
            role: 'system',
            content: `Wewe ni msaidizi wa ALFEAN ENTERPRISES — mfumo wa usimamizi wa biashara kwa maduka Tanzania.

${SYSTEM_KNOWLEDGE}

MAELEKEZO MUHIMU:
1. ${langInstruction}
2. Toa majibu kamili, ya kina, na yenye maelezo mengi. Usiwe mfupi.
3. Kama swali linahusu kipengele fulani, eleza kwa undani jinsi kinavyofanya kazi, faida zake, na gharama zake.
4. Kama mtumiaji ana shida au anahitaji msaada wa ziada unaozidi uwezo wako, mwambie "Tafadhali acha barua pepe yako hapa ili timu yetu ya msaada iweze kukusaidia zaidi" na kutoa namba ya simu kwa mawasiliano ya haraka.
5. Kama anauliza bei au usajili: mweleze wazi kuwa mfumo ni BURE kutumia na hakuna malipo ya usajili. Kinacholipiwa ni krediti za SMS tu, ambazo zinunuliwa kwenye SMS Center kwa M-Pesa. Kamwe usiuze wala kutaja mipango ya usajili.
6. Kama anauliza kuhusu jinsi ya kuanza, mwelekeze hatua kwa hatua.
7. Daima kuwa mwaminifu — usibuni vitu ambavyo si sehemu ya mfumo.
8. Tumia lugha ya kitaalamu, yenye heshima, na inayowafaa wafanyabiashara.
9. Mwishoni mwa kila jibu, unaweza kuuliza "Je, una swali lingine lolote?" au "Ninaweza kukusaidia na jambo lingine?"
10. Usiwahi kusema "kwa maelezo zaidi tembelea tovuti yetu" badala yake toa maelezo kamili hapo hapo.

KAMA HAUWEZI KUSAIDIA au swali ni tata: omba mtumiaji aache barua pepe yake ili timu ya msaada iwasiliane naye.

DATA ZAIDI:
- App URL: ${APP_URL}
${landingBlock}`
          },
          {
            role: 'user',
            content: message
          }
        ],
        max_tokens: 2000,
        temperature: 0.7
      })
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error('[Public Chat] DeepSeek error:', response.status, errBody);
      return c.json({ success: false, error: 'AI service error' }, 502);
    }

    const data: any = await response.json();
    const reply = data.choices?.[0]?.message?.content || 'Samahani, kuna tatizo. Tafadhali jaribu tena.';

    return c.json({
      success: true,
      data: {
        reply,
        language
      }
    });

  } catch (e: any) {
    console.error('[Public Chat] Error:', e.message);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

router.post('/chat/contact', async (c) => {
  try {
    // Same abuse guard as the chat: prevents spam rows in contact_requests.
    if (!checkPublicChatRateLimit(c)) {
      return c.json({ success: false, error: 'Too many requests. Please try again later.' }, 429);
    }
    const { name, email, message } = await c.req.json();

    if (!email || typeof email !== 'string') {
      return c.json({ success: false, error: 'Email is required' }, 400);
    }
    if (isDisposableEmail(email)) {
      return c.json({ success: false, error: 'Please use a permanent email address.' }, 400);
    }

    const result = await pool.query(
      `INSERT INTO contact_requests (name, email, message, created_at) VALUES ($1, $2, $3, NOW()) RETURNING id`,
      [name || null, email, message || null]
    );

    console.log(`[Public Chat] New contact request #${result.rows[0].id} from ${email}`);

    return c.json({
      success: true,
      data: {
        message: 'Asante! Timu yetu ya msaada itawasiliana nawe hivi karibuni. / Thank you! Our support team will contact you soon.'
      }
    }, 201);

  } catch (e: any) {
    console.error('[Public Chat] Contact error:', e.message);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// =====================================================
// COUPONS — public verification (landing page + checkout)
// =====================================================

const couponPublicShape = (row: any) => ({
  id: row.id,
  code: row.code,
  title: row.title,
  description: row.description,
  discount_percent: row.discount_percent ?? 0,
  bonus_days: row.bonus_days ?? 0,
  expires_at: row.expires_at,
  max_uses: row.max_uses,
  used_count: row.used_count ?? 0,
});

// The best live shared coupon (for the landing-page countdown banner).
router.get('/coupon', async (c) => {
  try {
    const result = await pool.query(`
      SELECT * FROM subscription_offers
      WHERE is_active = true
        AND code IS NOT NULL AND code <> ''
        AND (tenant_ids IS NULL OR cardinality(tenant_ids) = 0)
        AND (expires_at IS NULL OR expires_at > NOW())
        AND (max_uses IS NULL OR used_count < max_uses)
      ORDER BY discount_percent DESC, expires_at ASC NULLS LAST
      LIMIT 1
    `);
    return c.json({ success: true, data: result.rows.length ? couponPublicShape(result.rows[0]) : null });
  } catch (e: any) {
    return c.json({ success: true, data: null });
  }
});

// Verify a coupon code typed by a user — confirms it is a genuine ALFEAN ENTERPRISES coupon.
router.get('/coupon/:code', async (c) => {
  try {
    const code = String(c.req.param('code') || '').trim().toUpperCase();
    if (!code) {
      return c.json({ success: true, data: { valid: false, reason: 'Weka kodi ya kuponi' } });
    }

    const result = await pool.query(`
      SELECT * FROM subscription_offers
      WHERE UPPER(code) = $1
      ORDER BY created_at DESC LIMIT 1
    `, [code]);

    if (result.rows.length === 0) {
      return c.json({ success: true, data: { valid: false, reason: 'Kuponi hii haipo kwenye mfumo wa ALFEAN ENTERPRISES' } });
    }

    const row = result.rows[0];
    if (!row.is_active) {
      return c.json({ success: true, data: { valid: false, reason: 'Kuponi hii imesimamishwa' } });
    }
    if (row.expires_at && new Date(row.expires_at) <= new Date()) {
      return c.json({ success: true, data: { valid: false, reason: 'Kuponi hii imeisha muda wake' } });
    }
    if (row.max_uses != null && (row.used_count || 0) >= row.max_uses) {
      return c.json({ success: true, data: { valid: false, reason: 'Kuponi hii imetumika mara zote zilizoruhusiwa' } });
    }

    return c.json({ success: true, data: { valid: true, ...couponPublicShape(row) } });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// ---------------------------------------------------------------------------
// Public receipt verification (QR code on printed receipts)
// ---------------------------------------------------------------------------
// The QR printed on every receipt points at /r/<token>; the page calls this
// endpoint with the token. Only the data that is already printed on the paper
// receipt is exposed — no internal ids, no customer contact details.
router.get('/receipt/:token', async (c) => {
  try {
    const token = String(c.req.param('token') || '').trim();
    if (!token || token.length > 64) {
      return c.json({ success: false, error: 'Invalid receipt token' }, 400);
    }

    const saleRes = await pool.query(
      `SELECT s.id, s.receipt_number, s.created_at, s.total_amount, s.discount_amount,
              s.payment_method, s.amount_paid, s.payment_status, s.sale_type, s.bank_name,
              sh.name AS shop_name, sh.business_name, sh.branch_name, sh.address, sh.phone,
              sh.email, sh.tin_number, sh.vrn_number, sh.logo, sh.invoice_footer
         FROM sales s
         JOIN shops sh ON sh.id = s.shop_id
        WHERE s.receipt_token = $1
        LIMIT 1`,
      [token]
    );
    if (saleRes.rows.length === 0) {
      return c.json({ success: false, error: 'Receipt not found' }, 404);
    }
    const sale = saleRes.rows[0];

    const itemsRes = await pool.query(
      `SELECT product_name, quantity, unit_price, total_price
         FROM sale_items WHERE sale_id = $1 ORDER BY created_at ASC, id ASC`,
      [sale.id]
    );
    const items = itemsRes.rows.map((it: any) => ({
      name: it.product_name,
      quantity: parseFloat(it.quantity) || 0,
      unitPrice: parseFloat(it.unit_price) || 0,
      total: parseFloat(it.total_price) || 0,
    }));

    const total = parseFloat(sale.total_amount) || 0;
    const amountPaid = parseFloat(sale.amount_paid) || 0;

    c.header('Cache-Control', 'no-store');
    return c.json({
      success: true,
      data: {
        verified: true,
        receiptNumber: sale.receipt_number,
        date: sale.created_at,
        shop: {
          name: sale.shop_name,
          businessName: sale.business_name || sale.shop_name,
          branchName: sale.branch_name || '',
          address: sale.address || '',
          phone: sale.phone || '',
          email: sale.email || '',
          tinNumber: sale.tin_number || '',
          vrnNumber: sale.vrn_number || '',
          logo: sale.logo || '',
          invoiceFooter: sale.invoice_footer || '',
        },
        items,
        totals: {
          subtotal: items.reduce((sum: number, it: any) => sum + it.quantity * it.unitPrice, 0),
          discount: parseFloat(sale.discount_amount) || 0,
          total,
          amountPaid,
          balanceDue: Math.max(0, total - amountPaid),
        },
        paymentMethod: sale.payment_method,
        paymentStatus: sale.payment_status,
        saleType: sale.sale_type,
        bankName: sale.bank_name || '',
        itemCount: items.length,
      },
    });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

export default router;
