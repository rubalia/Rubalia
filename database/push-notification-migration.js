
"use strict";

const pool = require("../config/database");

async function runPushNotificationMigration() {

  // =========================================
  // REGISTERED PUSH DEVICES
  // =========================================

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

  // =========================================
  // ADMIN PUSH MESSAGE LIBRARY
  // Stores drafts and sent notifications.
  // =========================================

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_push_messages (
      id BIGSERIAL PRIMARY KEY,

      title VARCHAR(180) NOT NULL,

      message TEXT NOT NULL,

      notification_link TEXT,

      audience VARCHAR(20) NOT NULL DEFAULT 'all',

      status VARCHAR(20) NOT NULL DEFAULT 'draft',

      recipient_count INTEGER NOT NULL DEFAULT 0,

      device_count INTEGER NOT NULL DEFAULT 0,

      success_count INTEGER NOT NULL DEFAULT 0,

      failure_count INTEGER NOT NULL DEFAULT 0,

      created_by BIGINT
        REFERENCES users(id) ON DELETE SET NULL,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      sent_at TIMESTAMPTZ,

      CONSTRAINT admin_push_audience_valid
        CHECK (
          audience IN ('all', 'partners', 'customers')
        ),

      CONSTRAINT admin_push_status_valid
        CHECK (
          status IN ('draft', 'sent', 'failed')
        ),

      CONSTRAINT admin_push_counts_nonnegative
        CHECK (
          recipient_count >= 0
          AND device_count >= 0
          AND success_count >= 0
          AND failure_count >= 0
        )
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_admin_push_messages_created
    ON admin_push_messages(created_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_admin_push_messages_status
    ON admin_push_messages(status);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_admin_push_messages_admin
    ON admin_push_messages(created_by, created_at DESC);
  `);

  console.log("Push devices migration completed.");
  console.log("Admin push message library migration completed.");
}

module.exports = {
  runPushNotificationMigration
};
