"use strict";

const pool = require("../config/database");

async function runApiManagementMigration() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_request_logs (
      id BIGSERIAL PRIMARY KEY,
      method VARCHAR(12) NOT NULL,
      endpoint VARCHAR(500) NOT NULL,
      status_code INTEGER NOT NULL,
      response_time_ms NUMERIC(12,3) NOT NULL DEFAULT 0,
      ip_address VARCHAR(100),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    idx_api_request_logs_created
    ON api_request_logs(created_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    idx_api_request_logs_status
    ON api_request_logs(status_code);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    idx_api_request_logs_endpoint
    ON api_request_logs(endpoint);
  `);

  console.log("API management database migration completed.");
}

module.exports = {
  runApiManagementMigration
};
