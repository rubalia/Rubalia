
"use strict";

const pool = require("../config/database");

/**
 * RUBALIA NETWORK
 * Partner System Database Migration
 *
 * This migration is additive:
 * - Preserves all existing users and records.
 * - Does not drop or truncate any table.
 * - Adds the partner activation timestamp.
 */

async function runPartnerMigration() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Add partner activation timestamp if it does not already exist.
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS partner_activated_at TIMESTAMPTZ;
    `);

    // Index for partner activation queries.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_partner_activated_at
      ON users (partner_activated_at);
    `);

    await client.query("COMMIT");

    console.log(
      "RUBALIA: Partner migration completed successfully. Existing data preserved."
    );
  } catch (error) {
    await client.query("ROLLBACK");

    console.error(
      "RUBALIA: Partner migration failed:",
      error.message
    );

    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  runPartnerMigration
};
