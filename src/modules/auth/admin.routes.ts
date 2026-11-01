import { Hono } from "hono";
import { hashPassword } from "@better-auth/utils/password";
import { auth } from "../../auth.js";
import { pool } from "../../config/drizzle.js";
import { authMiddleware, invalidateUserAuthCache } from "../../middleware/auth.middleware.js";
import { isSuperAdmin, requirePermission } from "../../middleware/rbac.middleware.js";
import { requireActiveSubscription } from "../../middleware/subscription.middleware.js";
import { checkAdminLimit, checkSellerLimit, limitErrorResponse } from "../../services/plan-limits.service.js";

const router = new Hono<{
  Variables: {
    userId: string;
    userRole: string;
    tenantId: string;
    shopIds: string[];
  }
}>();

router.post('/create-user', authMiddleware, requirePermission('user:create'), requireActiveSubscription, async (c) => {
  try {
    const { email, password, firstName, lastName, name, role, shopId } = await c.req.json();
    
    // Validation
    if (!email) {
      return c.json({ success: false, error: 'Email is required' }, 400);
    }
    if (!password) {
      return c.json({ success: false, error: 'Password is required' }, 400);
    }
    if (password.length < 8) {
      return c.json({ success: false, error: 'Password must be at least 8 characters' }, 400);
    }
    if (!name && !firstName) {
      return c.json({ success: false, error: 'Name is required' }, 400);
    }
    
    // Handle name fields
    let userName = name || `${firstName || ''} ${lastName || ''}`.trim();
    // Admin-created users can be sellers, store/back-office staff or admins.
    // Anything else (e.g. the legacy 'user' option) is treated as a seller so
    // a "muuzaji" never silently becomes a tenant-wide admin.
    const requestedRole = String(role || '').toLowerCase();
    const userRole = requestedRole === 'admin' ? 'admin' : requestedRole === 'store' ? 'store' : 'seller';

    // A caller may only assign shops they themselves can access.
    const callerShopIdsForAssign = (c.get('shopIds') as string[]) || [];
    if (shopId && c.get('userRole') !== 'developer' && !callerShopIdsForAssign.includes(shopId)) {
      return c.json({ success: false, error: 'You do not have access to that shop' }, 403);
    }

    // Assigns a shop exactly once. Sellers are ONLY ever put in the shop the
    // owner explicitly picked — no hidden extra memberships that would let them
    // discover the owner's other shops. Admins fall back to the owner's first
    // shop (they manage the whole tenant anyway).
    const assignShopToUser = async (targetUserId: string, requestedShopId: string | null): Promise<string | null> => {
      let shopToAssign = requestedShopId;
      if (!shopToAssign && userRole === 'admin' && callerShopIdsForAssign.length > 0) {
        shopToAssign = callerShopIdsForAssign[0];
      }
      if (!shopToAssign) return null;
      await pool.query(
        'UPDATE "user" SET shop_id = $1, updated_at = NOW() WHERE id = $2',
        [shopToAssign, targetUserId]
      );
      await pool.query(
        `INSERT INTO user_shops (user_id, shop_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, shop_id) DO UPDATE SET role = $3`,
        [targetUserId, shopToAssign, userRole === 'admin' ? 'owner' : userRole === 'store' ? 'store' : 'seller']
      );
      return shopToAssign;
    };
    
    // Check if user already exists by email
    const existingUser = await pool.query(
      'SELECT id, email FROM "user" WHERE email = $1',
      [email]
    );

    // Plan/trial seat limits — only when this user is not already part of the
    // tenant (re-inviting an existing member must never be blocked).
    const callerRole = c.get('userRole') as string;
    const callerTenantId = c.get('tenantId') as string;
    if (callerRole !== 'developer' && callerTenantId) {
      const targetId = existingUser.rows[0]?.id;
      let alreadyMember = false;
      if (targetId) {
        const memberCheck = await pool.query(
          `SELECT 1 FROM "user" WHERE id = $1 AND tenant_id = $2::text LIMIT 1`,
          [targetId, callerTenantId]
        );
        alreadyMember = memberCheck.rows.length > 0;
      }
      if (!alreadyMember) {
        const gate = userRole === 'admin'
          ? await checkAdminLimit(callerTenantId, 1)
          : await checkSellerLimit(callerTenantId, 1);
        const limitError = limitErrorResponse(gate);
        if (limitError) return c.json(limitError, 403);
      }
    }
    
    let userId: string;
    
    if (existingUser.rows.length > 0) {
      // User already exists - check if they have a credential account
      const existingAccount = await pool.query(
        'SELECT id, password FROM account WHERE user_id = $1 AND provider_id = $2',
        [existingUser.rows[0].id, 'credential']
      );
      
      if (existingAccount.rows.length > 0) {
        if (existingAccount.rows[0].password) {
          return c.json({ 
            success: false, 
            error: 'User with this email already exists and has a password. Please try logging in or reset the password.' 
          }, 400);
        }
        
        // User exists with null password - update it - use Better Auth scrypt hashing
        const passwordHash = await hashPassword(password);
        await pool.query(
          `UPDATE account SET password = $1, updated_at = NOW() WHERE user_id = $2 AND provider_id = 'credential'`,
          [passwordHash, existingUser.rows[0].id]
        );
        
        // Also ensure email_verified is true
        await pool.query(
          `UPDATE "user" SET email_verified = true, updated_at = NOW() WHERE id = $1`,
          [existingUser.rows[0].id]
        );
        
        return c.json({
          success: true,
          data: {
            id: existingUser.rows[0].id,
            email: email,
            name: userName,
            role: userRole,
            shopId: null
          }
        }, 201);
      }
      
      // User exists but no credential account - create one - use Better Auth scrypt hashing
      userId = existingUser.rows[0].id;
      const passwordHash = await hashPassword(password);
      await pool.query(
        `INSERT INTO account (user_id, provider_id, account_id, password, created_at, updated_at)
         VALUES ($1, 'credential', $1, $2, NOW(), NOW())`,
        [userId, passwordHash]
      );
      
      // Ensure email_verified is true
      await pool.query(
        `UPDATE "user" SET email_verified = true, updated_at = NOW() WHERE id = $1`,
        [userId]
      );
      
      // Re-invite of an existing account: honor the shop the owner picked.
      const assignedShopId = await assignShopToUser(userId, shopId || null);
      
      return c.json({
        success: true,
        data: {
          id: userId,
          email: email,
          name: userName,
          role: userRole,
          shopId: assignedShopId
        }
      }, 201);
    }
    
    // Create new user directly (avoid better-auth's signUpEmail which causes duplicate key issues)
    const currentUserTenantId = c.get('tenantId');
    
    // Get a tenant_id for the new user
    let tenantId = currentUserTenantId;
    if (!tenantId && callerShopIdsForAssign.length > 0) {
      const shopResult = await pool.query(
        'SELECT tenant_id FROM shops WHERE id = $1',
        [callerShopIdsForAssign[0]]
      );
      tenantId = shopResult.rows[0]?.tenant_id;
    }
    
    // Generate UUID for new user
    const { v4: uuidv4 } = await import('uuid');
    userId = uuidv4();
    
    // Insert new user
    await pool.query(
      `INSERT INTO "user" (id, email, email_verified, name, role, tenant_id, created_at, updated_at)
       VALUES ($1, $2, true, $3, $4, $5, NOW(), NOW())`,
      [userId, email, userName, userRole, tenantId]
    );
    
    // Create credential account for the user - check if already exists first
    const checkAccount = await pool.query(
      'SELECT id, password FROM account WHERE user_id = $1 AND provider_id = $2',
      [userId, 'credential']
    );
    
    // Hash password using Better Auth's scrypt hashing so login works
    const passwordHash = await hashPassword(password);
    
    if (checkAccount.rows.length === 0) {
      // No account exists, create one with UUID
      await pool.query(
        `INSERT INTO account (id, user_id, provider_id, account_id, password, created_at, updated_at)
         VALUES ($1, $2, 'credential', $2, $3, NOW(), NOW())`,
        [uuidv4(), userId, passwordHash]
      );
    } else if (!checkAccount.rows[0].password) {
      // Account exists but password is null, update it
      await pool.query(
        `UPDATE account SET password = $1, updated_at = NOW() WHERE user_id = $2 AND provider_id = 'credential'`,
        [passwordHash, userId]
      );
    }
    
    // Handle shop assignment — exactly the picked shop (sellers), or the
    // owner's first shop for a new admin.
    let assignedShopId = await assignShopToUser(userId, shopId || null);

    // A brand-new admin for a fresh tenant still needs a shop to manage.
    if (!assignedShopId && userRole === 'admin' && tenantId) {
      const existingTenantShops = await pool.query(
        'SELECT id FROM shops WHERE tenant_id = $1 LIMIT 1',
        [tenantId]
      );
      
      if (existingTenantShops.rows.length > 0) {
        assignedShopId = await assignShopToUser(userId, existingTenantShops.rows[0].id);
      } else {
        const shopCode = 'SHOP-' + Date.now().toString(36).toUpperCase();
        const newShopResult = await pool.query(
          `INSERT INTO shops (tenant_id, name, code, phone)
           VALUES ($1, 'My Shop', $2, NULL)
           RETURNING id`,
          [tenantId, shopCode]
        );
        if (newShopResult.rows.length > 0) {
          assignedShopId = await assignShopToUser(userId, newShopResult.rows[0].id);
        }
      }
    }
    
    return c.json({
      success: true,
      data: {
        id: userId,
        email: email,
        name: userName,
        role: userRole,
        shopId: assignedShopId
      }
    }, 201);
  } catch (error: any) {
    console.error('Create user error:', error);
    return c.json({ success: false, error: error.message }, 400);
  }
});

router.get('/list-users', authMiddleware, requirePermission('user:read'), async (c) => {
  try {
    const userRole = c.get('userRole');
    const shopIds = c.get('shopIds') as string[];
    const userId = c.get('userId');
    
    let query = 'SELECT u.id, u.email, u.name, u.role, u.shop_id, u.tenant_id, u.banned, u.first_name, u.last_name, u.created_at, u.last_login_at, (SELECT MAX(s.updated_at) FROM session s WHERE s.user_id = u.id AND s.expires_at > NOW()) as last_active, (SELECT COUNT(*) FROM user_shops us WHERE us.user_id = u.id) as shop_count FROM "user" u';
    let params: any[] = [];

    if (userRole === 'developer') {
      // Super admin sees all users except themselves
      query += ' WHERE u.role != $1';
      params = ['developer'];
    } else {
      // Regular admin/seller only sees users in their shops (not super_admin)
      if (shopIds && shopIds.length > 0) {
        query += ' WHERE u.shop_id = ANY($1) AND u.role != $2';
        params = [shopIds, 'developer'];
      } else {
        query += ' WHERE u.role != $1';
        params = ['developer'];
      }
    }
    
    query += ' ORDER BY u.created_at DESC';
    
    const result = await pool.query(query, params);
    
    return c.json({
      success: true,
      data: result.rows.map(user => ({
        id: user.id,
        email: user.email,
        name: user.name,
        firstName: user.first_name,
        lastName: user.last_name,
        role: user.role,
        shopId: user.shop_id,
        tenantId: user.tenant_id,
        banned: user.banned === true,
        shopCount: Number(user.shop_count || 0),
        createdAt: user.created_at,
        lastLoginAt: user.last_login_at,
        lastActive: user.last_active
      }))
    });
  } catch (error: any) {
    console.error('List users error:', error);
    return c.json({ success: false, error: error.message }, 400);
  }
});

router.put('/update-user/:id', authMiddleware, requirePermission('user:update'), requireActiveSubscription, async (c) => {
  try {
    const userId = c.req.param('id');
    const { firstName, lastName, role, shopId, isActive, email, password } = await c.req.json();
    
    // Check if target user is super_admin - cannot modify super_admin
    const targetIsSuperAdmin = await isSuperAdmin(userId);
    if (targetIsSuperAdmin) {
      return c.json({ 
        success: false, 
        error: 'Cannot modify super admin account' 
      }, 403);
    }
    
    // Check if email is already taken by another user
    if (email) {
      const existingUser = await pool.query(
        'SELECT id FROM "user" WHERE email = $1 AND id != $2',
        [email, userId]
      );
      if (existingUser.rows.length > 0) {
        return c.json({ success: false, error: 'Email already in use by another user' }, 409);
      }
    }
    
    // Build update query dynamically
    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;
    
    if (email !== undefined) {
      updates.push(`email = $${paramIndex}`);
      values.push(email);
      paramIndex++;
    }
    
    if (firstName !== undefined) {
      updates.push(`name = $${paramIndex}`);
      values.push(`${firstName} ${lastName || ''}`.trim());
      paramIndex++;
      updates.push(`first_name = $${paramIndex}`);
      values.push(firstName);
      paramIndex++;
    }
    
    if (lastName !== undefined) {
      updates.push(`last_name = $${paramIndex}`);
      values.push(lastName);
      paramIndex++;
    }
    
    if (role !== undefined) {
      // Promoting a seller to admin consumes an admin seat — check the plan limit.
      const callerRole = c.get('userRole') as string;
      const tenantId = c.get('tenantId') as string;
      if (callerRole !== 'developer' && tenantId && (role === 'admin' || role === 'owner')) {
        const currentRes = await pool.query(`SELECT role FROM "user" WHERE id = $1`, [userId]);
        const currentRole = currentRes.rows[0]?.role;
        if (currentRole !== 'admin' && currentRole !== 'owner') {
          const gate = await checkAdminLimit(tenantId, 1);
          const limitError = limitErrorResponse(gate);
          if (limitError) return c.json(limitError, 403);
        }
      }
      updates.push(`role = $${paramIndex}`);
      values.push(role);
      paramIndex++;

      // Keep shop membership in step with the new role so Shop Members shows
      // the correct role and the store/back-office nav matches immediately.
      // Never demote a shop owner's membership row.
      if (['seller', 'manager', 'store'].includes(role)) {
        await pool.query(
          `UPDATE user_shops SET role = $1 WHERE user_id = $2 AND role <> 'owner'`,
          [role, userId]
        );
      }
    }
    
    if (password !== undefined && password !== null && password !== '') {
      if (password.length < 8) {
        return c.json({ success: false, error: 'Password must be at least 8 characters' }, 400);
      }
      const passwordHash = await hashPassword(password);
      await pool.query(
        `UPDATE account SET password = $1, updated_at = NOW() WHERE user_id = $2 AND provider_id = 'credential'`,
        [passwordHash, userId]
      );
    }
    
    if (shopId !== undefined) {
      updates.push(`shop_id = $${paramIndex}`);
      values.push(shopId);
      paramIndex++;
      
      // Also update user_shops table. Use the role being assigned (or the
      // user's current role) instead of hard-coding 'admin' so a Store/Seller
      // member keeps the correct role for the store/back-office experience.
      if (shopId) {
        let membershipRole = ['seller', 'manager', 'store'].includes(role) ? role : null;
        if (!membershipRole) {
          const currentRes = await pool.query(`SELECT role FROM "user" WHERE id = $1`, [userId]);
          const currentRole = currentRes.rows[0]?.role;
          membershipRole = ['seller', 'manager', 'store'].includes(currentRole) ? currentRole : 'admin';
        }
        await pool.query(
          `INSERT INTO user_shops (user_id, shop_id, role)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id, shop_id) DO UPDATE SET role = $3`,
          [userId, shopId, membershipRole]
        );
      }
    }
    
    const passwordWasUpdated = password !== undefined && password !== null && password !== '';
    
    // Check if there are any updates
    if (updates.length === 0 && !passwordWasUpdated) {
      return c.json({ success: false, error: 'No fields to update' }, 400);
    }
    
    let user;
    if (updates.length > 0) {
      updates.push(`updated_at = NOW()`);
      const result = await pool.query(
        `UPDATE "user" 
         SET ${updates.join(', ')}
         WHERE id = $${paramIndex}
         RETURNING id, email, name, role, shop_id, first_name, last_name`,
        [...values, userId]
      );
      if (result.rows.length === 0) {
        return c.json({ success: false, error: 'User not found' }, 404);
      }
      user = result.rows[0];
    } else {
      const result = await pool.query(
        `SELECT id, email, name, role, shop_id, first_name, last_name FROM "user" WHERE id = $1`,
        [userId]
      );
      if (result.rows.length === 0) {
        return c.json({ success: false, error: 'User not found' }, 404);
      }
      user = result.rows[0];
    }
    
    // Role / shop changes must apply on the very next request, not after the
    // auth cache TTL (a demoted admin kept tenant-wide access for 5 minutes).
    invalidateUserAuthCache(userId);
    
    return c.json({
      success: true,
      data: {
        id: user.id,
        email: user.email,
        name: user.name,
        firstName: user.first_name,
        lastName: user.last_name,
        role: user.role,
        shopId: user.shop_id
      }
    });
  } catch (error: any) {
    console.error('Update user error:', error);
    return c.json({ success: false, error: error.message }, 400);
  }
});

router.delete('/delete-user/:id', authMiddleware, requirePermission('user:delete'), requireActiveSubscription, async (c) => {
  try {
    const userId = c.req.param('id');
    
    // Don't allow deleting yourself
    const currentUserId = c.get('userId');
    if (userId === currentUserId) {
      return c.json({ success: false, error: 'Cannot delete your own account' }, 400);
    }
    
    // Check if target user is super_admin - cannot delete super_admin
    const targetIsSuperAdmin = await isSuperAdmin(userId);
    if (targetIsSuperAdmin) {
      return c.json({ 
        success: false, 
        error: 'Cannot delete super admin account' 
      }, 403);
    }
    
    // Delete from account table first ( Better Auth ), then delete user
    await pool.query('DELETE FROM account WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM "user" WHERE id = $1', [userId]);
    
    return c.json({ success: true, data: { message: 'User deleted successfully' } });
  } catch (error: any) {
    console.error('Delete user error:', error);
    return c.json({ success: false, error: error.message }, 400);
  }
});

export default router;

