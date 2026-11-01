import { testConnection } from "../config/drizzle.js";
import { pool } from "../config/drizzle.js";

export const checkDatabaseConnection = async (): Promise<boolean> => {
  return testConnection();
};

export const checkRequiredEnvVars = (): boolean => {
  const required = ['JWT_SECRET', 'BETTER_AUTH_SECRET'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:', missing.join(', '));
    return false;
  }
  
  console.log('✅ All required environment variables are set');
  return true;
};

export const initializeSuperAdminShop = async (): Promise<void> => {
  const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL?.toLowerCase();
  
  if (!SUPER_ADMIN_EMAIL) {
    console.log('⚠️  SUPER_ADMIN_EMAIL not set, skipping super admin shop creation');
    return;
  }
  
  try {
    // Check if super admin shop already exists
    const existingShop = await pool.query(
      `SELECT id, tenant_id FROM shops WHERE is_super_admin = true LIMIT 1`
    );
    
    if (existingShop.rows.length > 0) {
      console.log('✅ Super admin shop already exists');
      return;
    }
    
    // Check if tenant with this email already exists
    const existingTenant = await pool.query(
      `SELECT id FROM tenants WHERE email = $1 LIMIT 1`,
      [SUPER_ADMIN_EMAIL]
    );
    
    let tenantId: string;
    
    if (existingTenant.rows.length > 0) {
      // Use existing tenant
      tenantId = existingTenant.rows[0].id;
      console.log('✅ Using existing super admin tenant:', tenantId);
    } else {
      // Create new super admin tenant
      const tenantResult = await pool.query(
        `INSERT INTO tenants (name, slug, email, is_active, plan_type, created_at, updated_at)
         VALUES ($1, $2, $3, true, 'enterprise', NOW(), NOW())
         RETURNING id`,
        ['Super Admin System', 'super-admin-system', SUPER_ADMIN_EMAIL]
      );
      
      tenantId = tenantResult.rows[0].id;
      console.log('✅ Super admin tenant created:', tenantId);
    }
    
    // Create super admin shop with tenant reference
    const result = await pool.query(
      `INSERT INTO shops (tenant_id, name, code, is_super_admin, created_at, updated_at)
       VALUES ($1, $2, $3, true, NOW(), NOW())
       RETURNING id`,
      [tenantId, 'Super Admin', 'SUPER-ADMIN']
    );
    
    if (result.rows.length > 0) {
      console.log('✅ Super admin shop created:', result.rows[0].id);
    }
  } catch (error: any) {
    console.error('❌ Error creating super admin shop:', error.message);
  }
};

