"use strict";

const pool = require("../config/database");

async function runSettingsMigration() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_settings (
        user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        order_notifications BOOLEAN NOT NULL DEFAULT TRUE,
        team_notifications BOOLEAN NOT NULL DEFAULT TRUE,
        promotional_notifications BOOLEAN NOT NULL DEFAULT TRUE,
        email_notifications BOOLEAN NOT NULL DEFAULT TRUE,
        language VARCHAR(2) NOT NULL DEFAULT 'en'
          CHECK (language = 'en'),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS account_deactivation_requests (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id),
        reason TEXT,
        status VARCHAR(20) NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reviewed_at TIMESTAMPTZ,
        reviewed_by BIGINT REFERENCES users(id),
        admin_note TEXT
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_deactivation_requests_user
      ON account_deactivation_requests(user_id, created_at DESC);
    `);

    await client.query("COMMIT");
    console.log("Settings migration completed. Existing data preserved.");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Settings migration failed:", error.message);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { runSettingsMigration };
