
"use strict";

const pool = require("../config/database");

async function runPushNotificationMigration() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_devices (
      id BIGSERIAL PRIMARY KEY,

      user_id BIGINT NOT NULL
        REFERENCES users(id) ON DELETE CASCADE,

      token TEXT NOT NULL UNIQUE,

      platform VARCHAR(20) NOT NULL DEFAULT 'android',

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_push_devices_user
    ON push_devices(user_id);
  `);

  console.log("Push notification database migration completed.");
}

module.exports = {
  runPushNotificationMigration
};
