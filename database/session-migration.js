"use strict";

const pool = require("../config/database");

async function runSessionMigration() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_sessions (
        id BIGSERIAL PRIMARY KEY,

        session_id UUID NOT NULL UNIQUE,

        user_id BIGINT NOT NULL
          REFERENCES users(id)
          ON DELETE CASCADE,

        last_activity_at TIMESTAMPTZ NOT NULL
          DEFAULT NOW(),

        created_at TIMESTAMPTZ NOT NULL
          DEFAULT NOW(),

        expires_at TIMESTAMPTZ NOT NULL,

        revoked_at TIMESTAMPTZ,

        device_info TEXT
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS
      idx_user_sessions_user_id
      ON user_sessions(user_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS
      idx_user_sessions_last_activity
      ON user_sessions(last_activity_at);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS
      idx_user_sessions_expires_at
      ON user_sessions(expires_at);
    `);

    await client.query("COMMIT");

    console.log(
      "User session migration completed."
    );

  } catch (error) {
    await client.query("ROLLBACK");
    throw error;

  } finally {
    client.release();
  }
}

module.exports = {
  runSessionMigration
};
