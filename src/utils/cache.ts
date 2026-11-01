/**
 * =====================================================
 * IN-MEMORY CACHE UTILITY
 * =====================================================
 * 
 * Provides a simple in-memory cache with TTL support
 * to reduce database load for frequently accessed data.
 * 
 * USAGE:
 *   import cache, { CACHE_KEYS, invalidateCache } from '../utils/cache.js';
 * 
 *   // Get from cache or fetch from DB
 *   const data = await cache.getOrSet(CACHE_KEYS.PLANS, () => pool.query('SELECT * FROM plans'), 300);
 * 
 *   // Invalidate when data changes
 *   invalidateCache('plans');
 */

interface CacheEntry<T = any> {
  data: T;
  expires: number;
}

const MAX_ENTRIES = 500;

class Cache {
  private store = new Map<string, CacheEntry>();
  private accessOrder: string[] = [];
  private inFlight = new Map<string, Promise<unknown>>();

  private evictIfNeeded(): void {
    if (this.store.size < MAX_ENTRIES) return;
    const expired: string[] = [];
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expires) expired.push(key);
    }
    for (const key of expired) this.store.delete(key);
    while (this.store.size >= MAX_ENTRIES && this.accessOrder.length > 0) {
      const lru = this.accessOrder.shift();
      if (lru && this.store.has(lru) && now <= (this.store.get(lru)?.expires ?? 0)) {
        this.store.delete(lru);
      }
    }
  }

  private recordAccess(key: string): void {
    const idx = this.accessOrder.indexOf(key);
    if (idx !== -1) this.accessOrder.splice(idx, 1);
    this.accessOrder.push(key);
  }

  get<T = any>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expires) {
      this.store.delete(key);
      return null;
    }
    this.recordAccess(key);
    return entry.data as T;
  }

  set<T = any>(key: string, data: T, ttlSeconds: number = 300): void {
    this.evictIfNeeded();
    const ttl = ttlSeconds > 3600 ? ttlSeconds / 1000 : ttlSeconds;
    this.store.set(key, {
      data,
      expires: Date.now() + ttl * 1000,
    });
    this.recordAccess(key);
  }

  async getOrSet<T = any>(
    key: string,
    fetcher: () => Promise<T>,
    ttlSeconds: number = 300
  ): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== null) return cached;

    // Collapse a burst of identical cache misses into one database request.
    // This matters when many devices open the dashboard at the same time or
    // when a short-lived stats entry expires for all shops together.
    const pending = this.inFlight.get(key) as Promise<T> | undefined;
    if (pending) return pending;

    let request: Promise<T>;
    request = fetcher()
      .then((data) => {
        this.set(key, data, ttlSeconds);
        return data;
      })
      .finally(() => {
        if (this.inFlight.get(key) === request) this.inFlight.delete(key);
      });

    this.inFlight.set(key, request);
    return request;
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  invalidateByPrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  clear(): void {
    this.store.clear();
    this.inFlight.clear();
  }

  stats(): { size: number; keys: string[] } {
    return {
      size: this.store.size,
      keys: Array.from(this.store.keys()),
    };
  }
}

export const cache = new Cache();

export const CACHE_KEYS = {
  PLANS: 'subscription:plans',
  OFFERS: 'subscription:offers',
  TRIAL_SETTINGS: 'trial:settings',
  TRIAL_STATS: 'trial:stats',
  SYSTEM_SETTINGS: 'system:settings',
  FEATURES: 'system:features',
  PRODUCTS: 'products',
  PRODUCT_COUNTS: 'product:counts',
  CATEGORIES: 'categories',
  SHOPS: 'shops',
  PERMISSIONS: 'permissions',
  TENANTS: 'tenants',
  SUBSCRIPTION_STATS: 'subscription:stats',
  REVENUE: 'revenue',
  CEO_STATS: 'ceo:stats',
  HEALTH: 'system:health',
} as const;

export function invalidateCache(key: string): void {
  cache.invalidate(key);
}

export function invalidateCacheByPrefix(prefix: string): void {
  cache.invalidateByPrefix(prefix);
}

export default cache;
