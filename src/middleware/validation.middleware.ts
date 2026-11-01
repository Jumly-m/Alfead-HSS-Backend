import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { DEBUG_LOGS } from '../config/index.js';

// Sanitize string to prevent XSS and injection attacks
const sanitizeString = (value: any): any => {
  if (typeof value === 'string') {
    // Remove null bytes and control characters that could be used for injection
    return value.replace(/[\x00-\x1F\x7F]/g, '').trim();
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeString);
  }
  if (typeof value === 'object' && value !== null) {
    const sanitized: Record<string, any> = {};
    for (const [key, val] of Object.entries(value)) {
      sanitized[key] = sanitizeString(val);
    }
    return sanitized;
  }
  return value;
};

export const validateBody = (schema: z.ZodSchema) => {
  return createMiddleware(async (c, next) => {
    try {
      const body = await c.req.json();
      // Raw request bodies (sale items, customer names/phones, prices) must
      // never land in production logs. DEBUG_LOGS=true re-enables this for
      // local debugging.
      if (DEBUG_LOGS) console.log('[validateBody] Raw body:', JSON.stringify(body, null, 2));
      // Sanitize input before validation
      const sanitizedBody = sanitizeString(body);
      const validated = schema.parse(sanitizedBody);
      c.set('validatedBody', validated);
      await next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        if (DEBUG_LOGS) console.log('[validateBody] Validation error:', JSON.stringify(error.issues, null, 2));
        return c.json({
          success: false,
          error: 'Validation failed',
          details: error.issues.map(e => ({
            field: e.path.join('.'),
            message: e.message
          }))
        }, 400);
      }
      console.log('[validateBody] Non-Zod error:', error);
      return c.json({
        success: false,
        error: 'Invalid request body'
      }, 400);
    }
  });
};
