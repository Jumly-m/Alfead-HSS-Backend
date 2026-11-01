import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const { Pool } = pg;

const baseConfig = {
  connectionString: process.env.DATABASE_URL,
};

function poolSize(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const writePoolMax = poolSize('DB_WRITE_POOL_MAX', 10);
const readPoolMax = poolSize('DB_READ_POOL_MAX', 30);

// Primary pool for writes (INSERT, UPDATE, DELETE)
const writePool = new Pool({
  ...baseConfig,
  // Keep defaults conservative, but allow production to size pools for the
  // database tier instead of hard-coding connection limits in the app image.
  max: writePoolMax,
  min: Math.min(poolSize('DB_WRITE_POOL_MIN', 2), writePoolMax),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 30000,
  options: '-c timezone=UTC',
});

// Read pool for queries (SELECT)
const readPool = new Pool({
  ...baseConfig,
  max: readPoolMax,
  min: Math.min(poolSize('DB_READ_POOL_MIN', 5), readPoolMax),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 60000,
  options: '-c timezone=UTC',
});

writePool.on('error', (err) => {
  console.error('Write pool error:', err);
});

readPool.on('error', (err) => {
  console.error('Read pool error:', err);
});

// Database abstraction with read/write separation
export const db = {
  query: (text: string, params?: any[]) => readPool.query(text, params),
  write: (text: string, params?: any[]) => writePool.query(text, params),
  read: (text: string, params?: any[]) => readPool.query(text, params),
  getClient: () => writePool.connect(),
  
  transaction: async <T>(callback: (client: pg.PoolClient) => Promise<T>): Promise<T> => {
    const client = await writePool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
  
  batchInsert: async (table: string, columns: string[], rows: any[][]) => {
    if (rows.length === 0) return { rowCount: 0 };
    const columnNames = columns.join(', ');
    const valuePlaceholders = rows.map((_, rowIndex) => {
      const start = rowIndex * columns.length + 1;
      return `(${columns.map((_, colIndex) => `$${start + colIndex}`).join(', ')})`;
    }).join(', ');
    const flatValues = rows.flat();
    const query = `INSERT INTO ${table} (${columnNames}) VALUES ${valuePlaceholders}`;
    return writePool.query(query, flatValues);
  },
  
  bulkUpdate: async (table: string, updates: { id: string; [key: string]: any }[]) => {
    if (updates.length === 0) return { rowCount: 0 };
    const client = await writePool.connect();
    try {
      await client.query('BEGIN');
      for (const update of updates) {
        const { id, ...fields } = update;
        const setClauses = Object.keys(fields).map((key, index) => `${key} = $${index + 1}`).join(', ');
        const values = [...Object.values(fields), id];
        await client.query(`UPDATE ${table} SET ${setClauses} WHERE id = $${values.length}`, values);
      }
      await client.query('COMMIT');
      return { rowCount: updates.length };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
};

export { writePool, readPool };
export default { writePool, readPool, db };
