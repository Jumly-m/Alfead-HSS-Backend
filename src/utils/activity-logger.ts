import { pool } from "../config/drizzle.js";

// Helper function to validate UUID
const isValidUUID = (uuid: string): boolean => {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
};

export const logActivity = async ({
  userId,
  userName,
  userEmail,
  action,
  entityType,
  entityId,
  details,
  ipAddress,
  userAgent,
  shopId
}: {
  userId?: string;
  userName?: string;
  userEmail?: string;
  action: string;
  entityType?: string;
  entityId?: string;
  details?: any;
  ipAddress?: string;
  userAgent?: string;
  shopId?: string;
}) => {
  try {
    const validUserId = userId ? userId : null;
    const validEntityId = entityId && isValidUUID(entityId) ? entityId : null;
    const validShopId = shopId && isValidUUID(shopId) ? shopId : null;
    
    const columns: string[] = [
      'user_id', 'action', 'entity_type', 'entity_id',
      'details', 'ip_address', 'user_agent', 'created_at',
      'user_name', 'user_email'
    ];
    const values: any[] = [
      validUserId, action, entityType, validEntityId,
      JSON.stringify(details || {}), ipAddress, userAgent, new Date(),
      userName || 'System', userEmail || ''
    ];
    
    if (validShopId !== null && validShopId !== undefined) {
      columns.push('shop_id');
      values.push(validShopId);
    }
    
    const columnList = columns.join(', ');
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
    
    await pool.query(
      `INSERT INTO activity_logs (${columnList}) VALUES (${placeholders})`,
      values
    );
  } catch (error) {
    console.error('Failed to log activity:', error);
  }
};
export const logLogin = async ({
  userId,
  userEmail,
  userName,
  ipAddress,
  userAgent,
  status = 'success',
  failureReason
}: {
  userId?: string;
  userEmail?: string;
  userName?: string;
  ipAddress?: string;
  userAgent?: string;
  status?: 'success' | 'failed';
  failureReason?: string;
}) => {
  try {
    await pool.query(
      `INSERT INTO login_history (user_id, user_email, user_name, ip_address, user_agent, status, failure_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, userEmail, userName, ipAddress, userAgent, status, failureReason]
    );
  } catch (error) {
    console.error('Failed to log login:', error);
  }
};

export const logError = async ({
  errorType,
  message,
  stackTrace,
  userId,
  requestPath,
  requestMethod,
  ipAddress
}: {
  errorType: string;
  message: string;
  stackTrace?: string;
  userId?: string;
  requestPath?: string;
  requestMethod?: string;
  ipAddress?: string;
}) => {
  try {
    await pool.query(
      `INSERT INTO system_errors (error_type, message, stack_trace, user_id, request_path, request_method, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [errorType, message, stackTrace, userId, requestPath, requestMethod, ipAddress]
    );
  } catch (error) {
    console.error('Failed to log error:', error);
  }
};
