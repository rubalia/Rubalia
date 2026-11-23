"use strict";

const pool = require("../config/database");

async function runProfileImageMigration() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // ============================================
    // MEMBER PROFILE PHOTO COLUMNS
    // Existing users and their data are preserved.
    // ============================================

    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS avatar_url TEXT,
      ADD COLUMN IF NOT EXISTS avatar_public_id VARCHAR(255);
    `);

    await client.query("COMMIT");

    console.log("Profile image migration completed.");
    console.log("Member avatar columns are ready.");

  } catch (error) {
    await client.query("ROLLBACK");

    console.error(
      "Profile image migration failed:",
      error.message
    );

    throw error;

  } finally {
    client.release();
  }
}

module.exports = {
  runProfileImageMigration
};
