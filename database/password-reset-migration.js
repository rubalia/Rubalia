"use strict";

const pool = require("../config/database");

/**
 * RUBALIA NETWORK
 * Password Reset Database Migration
 *
 * Features:
 * - Secure password reset token storage
 * - SHA-256 token hash storage
 * - 15-minute token expiry support
 * - One-time token usage tracking
 * - User account relationship
 *
 * This migration is additive.
 * Existing users and database records are preserved.
 */

async function runPasswordResetMigration() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // =================================================
    // PASSWORD RESET TOKENS TABLE
    // =================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id BIGSERIAL PRIMARY KEY,

        user_id BIGINT NOT NULL
          REFERENCES users(id)
          ON DELETE CASCADE,

        token_hash VARCHAR(64) NOT NULL,

        expires_at TIMESTAMPTZ NOT NULL,

        used_at TIMESTAMPTZ,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT password_reset_token_hash_valid
          CHECK (token_hash ~ '^[a-f0-9]{64}$')
      );
    `);

    // =================================================
    // UNIQUE TOKEN HASH
    // =================================================

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
      idx_password_reset_tokens_hash
      ON password_reset_tokens(token_hash);
    `);

    // =================================================
    // USER LOOKUP INDEX
    // =================================================

    await client.query(`
      CREATE INDEX IF NOT EXISTS
      idx_password_reset_tokens_user
      ON password_reset_tokens(user_id, created_at DESC);
    `);

    // =================================================
    // EXPIRY CLEANUP INDEX
    // =================================================

    await client.query(`
      CREATE INDEX IF NOT EXISTS
      idx_password_reset_tokens_expiry
      ON password_reset_tokens(expires_at);
    `);

    // =================================================
    // UNUSED TOKEN LOOKUP INDEX
    // =================================================

    await client.query(`
      CREATE INDEX IF NOT EXISTS
      idx_password_reset_tokens_unused
      ON password_reset_tokens(user_id, expires_at)
      WHERE used_at IS NULL;
    `);

    await client.query("COMMIT");

    console.log("------------------------------------------");
    console.log("RUBALIA PASSWORD RESET MIGRATION");
    console.log("Password reset table created or verified.");
    console.log("Secure token hash storage enabled.");
    console.log("Token expiry tracking enabled.");
    console.log("One-time token usage tracking enabled.");
    console.log("Existing database records preserved.");
    console.log("------------------------------------------");

  } catch (error) {
    await client.query("ROLLBACK");

    console.error(
      "RUBALIA Password Reset Migration Failed:",
      error.message
    );

    throw error;

  } finally {
    client.release();
  }
}

module.exports = {
  runPasswordResetMigration
};
