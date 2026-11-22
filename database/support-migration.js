"use strict";

const pool = require("../config/database");

async function runSupportMigration() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS support_tickets (
        id BIGSERIAL PRIMARY KEY,
        ticket_reference VARCHAR(40) NOT NULL UNIQUE,
        user_id BIGINT NOT NULL REFERENCES users(id),
        subject VARCHAR(160) NOT NULL,
        category VARCHAR(50) NOT NULL,
        priority VARCHAR(10) NOT NULL DEFAULT 'normal',
        status VARCHAR(20) NOT NULL DEFAULT 'open',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT support_ticket_priority_valid
          CHECK (priority IN ('low', 'normal', 'high')),
        CONSTRAINT support_ticket_status_valid
          CHECK (status IN (
            'open', 'in_progress', 'waiting_member',
            'resolved', 'closed'
          ))
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS support_messages (
        id BIGSERIAL PRIMARY KEY,
        ticket_id BIGINT NOT NULL
          REFERENCES support_tickets(id) ON DELETE CASCADE,
        sender_id BIGINT NOT NULL REFERENCES users(id),
        sender_role VARCHAR(10) NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT support_message_sender_role_valid
          CHECK (sender_role IN ('member', 'admin'))
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_support_tickets_user_updated
      ON support_tickets(user_id, updated_at DESC);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_support_tickets_status_updated
      ON support_tickets(status, updated_at DESC);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_support_messages_ticket_created
      ON support_messages(ticket_id, created_at ASC);
    `);

    await client.query("COMMIT");

    console.log("Support ticket migration completed.");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Support migration failed:", error.message);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { runSupportMigration };
