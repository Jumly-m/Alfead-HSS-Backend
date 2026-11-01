import type { Context, Next } from 'hono';

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateUUID(paramName: string) {
  return async (c: Context, next: Next) => {
    const id = c.req.param(paramName);
    if (!id) return c.json({ success: false, error: `Missing ${paramName}` }, 400);
    
    if (!uuidRegex.test(id)) {
      return c.json({ 
        success: false, 
        error: `Invalid ${paramName} format. Must be a valid UUID.` 
      }, 400);
    }
    
    await next();
  };
}
