import type { ErrorHandler } from 'hono';
import { logError } from '../utils/activity-logger.js';
import { sendErrorAlert } from '../services/email.service.js';

// Debounce: track last notified time per error key to avoid email floods
const notifiedErrors = new Map<string, number>();
const DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes

function getErrorKey(errorType: string, requestPath?: string): string {
  return `${errorType}::${requestPath || '/'}`;
}

function shouldNotify(errorType: string, requestPath?: string): boolean {
  const key = getErrorKey(errorType, requestPath);
  const lastNotified = notifiedErrors.get(key);
  const now = Date.now();
  if (lastNotified && now - lastNotified < DEBOUNCE_MS) {
    return false;
  }
  notifiedErrors.set(key, now);
  return true;
}

export const errorHandler: ErrorHandler = (err, c) => {
  const reqPath = c.req.path;
  const reqMethod = c.req.method;
  const userId = c.get('userId') || 'anonymous';
  const ipAddress = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown';

  let errorType = 'INTERNAL_ERROR';
  let statusCode: any = 500;
  let responseBody: any = { success: false, error: 'Internal server error' };

  if (err.message?.includes('unique constraint')) {
    errorType = 'DUPLICATE_ENTRY';
    statusCode = 409;
    responseBody = { success: false, error: 'Resource already exists', code: 'DUPLICATE_ENTRY' };
  } else if (err.message?.includes('foreign key constraint')) {
    errorType = 'FOREIGN_KEY_VIOLATION';
    statusCode = 400;
    responseBody = { success: false, error: 'Referenced resource not found', code: 'FOREIGN_KEY_VIOLATION' };
  } else if (err.message?.includes('relation') || err.message?.includes('does not exist')) {
    errorType = 'DB_TABLE_NOT_FOUND';
    statusCode = 500;
    responseBody = { success: false, error: 'Database table not found', message: process.env.NODE_ENV === 'development' ? err.message : undefined };
  }

  // Log error to system_errors table (async, non-blocking)
  logError({
    errorType,
    message: err.message || 'Unknown error',
    stackTrace: err.stack,
    userId,
    requestPath: reqPath,
    requestMethod: reqMethod,
    ipAddress,
  });

  // Send email alert (async, debounced, non-blocking)
  if (shouldNotify(errorType, reqPath)) {
    sendErrorAlert({
      errorType,
      message: err.message || 'Unknown error',
      requestPath: reqPath,
      requestMethod: reqMethod,
      userId,
      stackTrace: err.stack,
    }).catch(e => console.error('[ErrorAlert] Failed to send email:', e.message));
  }

  return c.json(responseBody, statusCode);
};
