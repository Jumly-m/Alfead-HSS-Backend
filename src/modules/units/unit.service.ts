import type { z } from "zod";
import { db } from "../../config/database.js";
import type { createUnitSchema, updateUnitSchema } from "./unit.schema.js";

type CreateUnitInput = z.infer<typeof createUnitSchema>;
type UpdateUnitInput = z.infer<typeof updateUnitSchema>;

const DEFAULT_UNITS = [
  { code: 'PCS', name: 'Pieces', abbreviation: 'pcs', decimal_places: 0, stock_multiplier: 1, sort_order: 0 },
  { code: 'KG', name: 'Kilogram', abbreviation: 'kg', decimal_places: 2, stock_multiplier: 1, sort_order: 1 },
  { code: 'LTR', name: 'Litre', abbreviation: 'ltr', decimal_places: 2, stock_multiplier: 1, sort_order: 2 },
  { code: 'MTR', name: 'Meter', abbreviation: 'm', decimal_places: 2, stock_multiplier: 1, sort_order: 3 },
  { code: 'SQM', name: 'Square Meter', abbreviation: 'm²', decimal_places: 2, stock_multiplier: 1, sort_order: 4 },
  { code: 'TON', name: 'Ton', abbreviation: 'ton', decimal_places: 3, stock_multiplier: 1000, sort_order: 5 },
  { code: 'ROLL', name: 'Roll', abbreviation: 'roll', decimal_places: 0, stock_multiplier: 1, sort_order: 6 },
  { code: 'BOX', name: 'Box', abbreviation: 'box', decimal_places: 0, stock_multiplier: 1, sort_order: 7 },
  { code: 'PKG', name: 'Package', abbreviation: 'pkg', decimal_places: 0, stock_multiplier: 1, sort_order: 8 },
  { code: 'BND', name: 'Bundle', abbreviation: 'bnd', decimal_places: 0, stock_multiplier: 1, sort_order: 9 },
  { code: 'YRD', name: 'Yard', abbreviation: 'yd', decimal_places: 2, stock_multiplier: 1, sort_order: 10 },
  { code: 'SET', name: 'Set', abbreviation: 'set', decimal_places: 0, stock_multiplier: 1, sort_order: 11 },
];

// Ensures the shop_units table exists with every column this service uses.
//
// CREATE TABLE IF NOT EXISTS is a no-op on an existing table and the migration
// runner skips ADD COLUMN statements, so a shop_units table created by an older
// build can be missing columns (e.g. sort_order) — every units request then
// fails with "column ... does not exist" (500). Called once at startup and,
// on demand, when a query hits a missing table/column, so the endpoint heals
// itself instead of staying broken until the next restart.
export async function ensureShopUnitsSchema(): Promise<void> {
  // gen_random_uuid() is built into PostgreSQL 13+ (no extension needed), so
  // table creation can never fail because uuid-ossp is unavailable.
  await db.write(`
    CREATE TABLE IF NOT EXISTS shop_units (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      name VARCHAR(50) NOT NULL,
      code VARCHAR(20) NOT NULL,
      abbreviation VARCHAR(10),
      decimal_places INTEGER DEFAULT 2,
      stock_multiplier DECIMAL(12,6) DEFAULT 1,
      is_active BOOLEAN DEFAULT TRUE,
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(shop_id, code)
    )
  `);
  await db.write(`ALTER TABLE shop_units ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid()`);
  await db.write(`ALTER TABLE shop_units ADD COLUMN IF NOT EXISTS shop_id UUID`);
  await db.write(`ALTER TABLE shop_units ADD COLUMN IF NOT EXISTS name VARCHAR(50)`);
  await db.write(`ALTER TABLE shop_units ADD COLUMN IF NOT EXISTS code VARCHAR(20)`);
  await db.write(`ALTER TABLE shop_units ADD COLUMN IF NOT EXISTS abbreviation VARCHAR(10)`);
  await db.write(`ALTER TABLE shop_units ADD COLUMN IF NOT EXISTS decimal_places INTEGER DEFAULT 2`);
  await db.write(`ALTER TABLE shop_units ADD COLUMN IF NOT EXISTS stock_multiplier DECIMAL(12,6) DEFAULT 1`);
  await db.write(`ALTER TABLE shop_units ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE`);
  await db.write(`ALTER TABLE shop_units ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0`);
  await db.write(`ALTER TABLE shop_units ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`);
  await db.write(`ALTER TABLE shop_units ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`);
  // If the id column was just added, give existing rows a usable id so
  // update/delete keep working for them.
  await db.write(`UPDATE shop_units SET id = gen_random_uuid() WHERE id IS NULL`);
  await db.write(`CREATE INDEX IF NOT EXISTS shop_units_shop_id_idx ON shop_units(shop_id)`);
  await db.write(`CREATE INDEX IF NOT EXISTS shop_units_code_idx ON shop_units(code)`);
  // Repair databases created by migration 0020, which built shop_units WITHOUT
  // a unique key on (shop_id, code). Dedupe first, then add a unique index
  // (idempotent; the seeder's existence checks work either way).
  try {
    await db.write(`
      DELETE FROM shop_units a USING shop_units b
      WHERE a.ctid <> b.ctid AND a.shop_id = b.shop_id AND a.code = b.code
    `);
    await db.write(`CREATE UNIQUE INDEX IF NOT EXISTS shop_units_shop_code_uidx ON shop_units (shop_id, code)`);
  } catch (e: any) {
    console.warn('[Units] unique index check:', e.message);
  }
}

export class UnitService {
  // Seeds the default units EXACTLY ONCE per shop.
  //
  // Previously this ran whenever the shop had zero units, so deleting every
  // default brought all of them back on the next page load (and any custom
  // unit the user had added looked like it vanished). A marker row in
  // `settings` (key = units_seeded) survives empty tables, and shops that
  // already have units are marked without adding anything — so nothing a user
  // deleted ever comes back.
  private async seedDefaultsIfNeeded(shopId: string) {
    const marker = await db.read(
      `SELECT 1 FROM settings WHERE shop_id = $1 AND key = 'units_seeded' LIMIT 1`,
      [shopId]
    );
    if (marker.rows.length > 0) return;

    const count = await db.read(
      `SELECT COUNT(*) as c FROM shop_units WHERE shop_id = $1`,
      [shopId]
    );
    if (parseInt(count.rows[0].c) > 0) {
      // Existing shop (units from before this marker existed) — mark as seeded
      // and never inject defaults into it.
      await this.markSeeded(shopId);
      return;
    }

    for (const u of DEFAULT_UNITS) {
      // Existence check per row instead of ON CONFLICT: works whether or not
      // the (shop_id, code) unique index exists yet (older databases built by
      // migration 0020 lack it — ON CONFLICT would throw and break the list).
      const exists = await db.read(
        `SELECT 1 FROM shop_units WHERE shop_id = $1 AND code = $2 LIMIT 1`,
        [shopId, u.code]
      );
      if (exists.rows.length > 0) continue;
      await db.write(
        `INSERT INTO shop_units (shop_id, name, code, abbreviation, decimal_places, stock_multiplier, sort_order, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
        [shopId, u.name, u.code, u.abbreviation, u.decimal_places, u.stock_multiplier, u.sort_order]
      );
    }
    await this.markSeeded(shopId);
  }

  private async markSeeded(shopId: string) {
    try {
      // Delete + insert instead of ON CONFLICT: older databases don't have a
      // (shop_id, key) unique constraint on settings, so ON CONFLICT would fail
      // and the marker would never be written (bringing deleted defaults back).
      await db.write(`DELETE FROM settings WHERE shop_id = $1 AND key = 'units_seeded'`, [shopId]);
      await db.write(
        `INSERT INTO settings (shop_id, key, value) VALUES ($1, 'units_seeded', $2)`,
        [shopId, JSON.stringify({ seededAt: new Date().toISOString() })]
      );
    } catch (e: any) {
      console.warn('[Units] Could not mark units_seeded for shop', shopId, e.message);
    }
  }

  async findAll(shopId: string) {
    // Seeding is best-effort: a seeding problem (schema repair not applied yet,
    // duplicate rows, permissions) must NEVER turn the units list into a 500 —
    // the shop's own units are returned regardless.
    try {
      await this.seedDefaultsIfNeeded(shopId);
    } catch (e: any) {
      console.warn('[Units] seeding skipped:', e.message);
    }
    const select = () => db.read(
      `SELECT * FROM shop_units WHERE shop_id = $1 ORDER BY sort_order ASC, name ASC`,
      [shopId]
    );
    try {
      const result = await select();
      return result.rows;
    } catch (e: any) {
      // 42P01 = missing table, 42703 = missing column: an older shop_units
      // schema. Repair once and retry so the units list (and the Products/POS
      // unit pickers) never 500 on a schema gap.
      if (e.code === '42P01' || e.code === '42703') {
        console.warn('[Units] shop_units schema gap, repairing:', e.message);
        await ensureShopUnitsSchema();
        try { await this.seedDefaultsIfNeeded(shopId); } catch { /* best-effort */ }
        const retry = await select();
        return retry.rows;
      }
      throw e;
    }
  }

  async findById(id: string, shopId: string) {
    const result = await db.read(
      `SELECT * FROM shop_units WHERE id = $1 AND shop_id = $2`,
      [id, shopId]
    );
    if (result.rows.length === 0) return null;
    return result.rows[0];
  }

  async findByCode(code: string, shopId: string) {
    const result = await db.read(
      `SELECT * FROM shop_units WHERE code = $1 AND shop_id = $2`,
      [code, shopId]
    );
    if (result.rows.length === 0) return null;
    return result.rows[0];
  }

  async create(data: CreateUnitInput) {
    const { shopId, name, code, abbreviation, decimalPlaces, stockMultiplier, sortOrder } = data;
    const result = await db.write(
      `INSERT INTO shop_units (shop_id, name, code, abbreviation, decimal_places, stock_multiplier, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [shopId, name, code, abbreviation || null, decimalPlaces, stockMultiplier, sortOrder]
    );
    return result.rows[0];
  }

  async update(id: string, shopId: string, data: UpdateUnitInput) {
    const sets: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (data.name !== undefined) { sets.push(`name = $${paramIndex}`); values.push(data.name); paramIndex++; }
    if (data.abbreviation !== undefined) { sets.push(`abbreviation = $${paramIndex}`); values.push(data.abbreviation); paramIndex++; }
    if (data.decimalPlaces !== undefined) { sets.push(`decimal_places = $${paramIndex}`); values.push(data.decimalPlaces); paramIndex++; }
    if (data.stockMultiplier !== undefined) { sets.push(`stock_multiplier = $${paramIndex}`); values.push(data.stockMultiplier); paramIndex++; }
    if (data.isActive !== undefined) { sets.push(`is_active = $${paramIndex}`); values.push(data.isActive); paramIndex++; }
    if (data.sortOrder !== undefined) { sets.push(`sort_order = $${paramIndex}`); values.push(data.sortOrder); paramIndex++; }

    sets.push(`updated_at = NOW()`);
    values.push(id, shopId);

    const result = await db.write(
      `UPDATE shop_units SET ${sets.join(", ")} WHERE id = $${paramIndex} AND shop_id = $${paramIndex + 1} RETURNING *`,
      values
    );
    if (result.rows.length === 0) return null;
    return result.rows[0];
  }

  async delete(id: string, shopId: string) {
    const result = await db.write(
      `DELETE FROM shop_units WHERE id = $1 AND shop_id = $2 RETURNING *`,
      [id, shopId]
    );
    if (result.rows.length === 0) return null;
    return result.rows[0];
  }
}

export const unitService = new UnitService();
