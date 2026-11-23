
"use strict";

const pool = require("../config/database");

async function runModeratorMigration() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS moderators (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL UNIQUE
        REFERENCES users(id) ON DELETE CASCADE,

      status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'inactive')),

      permissions JSONB NOT NULL DEFAULT '{}'::jsonb,

      created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_moderators_status
    ON moderators(status);
  `);

  await pool.query(`
    ALTER TABLE users
    DROP CONSTRAINT IF EXISTS users_role_valid;
  `);

  console.log("Moderator permission database migration completed.");
}

module.exports = { runModeratorMigration };
