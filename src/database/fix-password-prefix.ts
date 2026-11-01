import { pool } from "../config/drizzle.js";

export async function removePasswordPrefix() {
  try {
    // Find all accounts with bcrypt: prefix in password
    const result = await pool.query(
      `SELECT id, password FROM account WHERE password LIKE 'bcrypt:%'`
    );

    if (result.rows.length === 0) {
      console.log('✅ No passwords with bcrypt: prefix found');
      return;
    }

    // Update each password to remove the prefix
    let updatedCount = 0;
    for (const row of result.rows) {
      const newPassword = row.password.replace(/^bcrypt:/, '');
      await pool.query(
        `UPDATE account SET password = $1, updated_at = NOW() WHERE id = $2`,
        [newPassword, row.id]
      );
      updatedCount++;
    }

    console.log(`✅ Removed bcrypt: prefix from ${updatedCount} passwords`);
  } catch (error) {
    console.log('⚠️ Password prefix cleanup error:', error);
  }
}
