"use strict";

const pool = require("../config/database");

async function runProductCostMigration() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // ================================================
    // PRODUCT COST FIELDS
    // ================================================

    await client.query(`
      ALTER TABLE products
      ADD COLUMN IF NOT EXISTS cost_price NUMERIC(14,2)
        NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS delivery_cost NUMERIC(14,2)
        NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS packaging_cost NUMERIC(14,2)
        NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS other_cost NUMERIC(14,2)
        NOT NULL DEFAULT 0;
    `);

    // ================================================
    // PACKAGE ADDITIONAL COST FIELDS
    // ================================================

    await client.query(`
      ALTER TABLE packages
      ADD COLUMN IF NOT EXISTS delivery_cost NUMERIC(14,2)
        NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS packaging_cost NUMERIC(14,2)
        NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS other_cost NUMERIC(14,2)
        NOT NULL DEFAULT 0;
    `);

    // ================================================
    // COST VALIDATION
    // ================================================

    await client.query(`
      ALTER TABLE products
      DROP CONSTRAINT IF EXISTS products_cost_values_valid;
    `);

    await client.query(`
      ALTER TABLE products
      ADD CONSTRAINT products_cost_values_valid
      CHECK (
        cost_price >= 0
        AND delivery_cost >= 0
        AND packaging_cost >= 0
        AND other_cost >= 0
      );
    `);

    await client.query(`
      ALTER TABLE packages
      DROP CONSTRAINT IF EXISTS packages_cost_values_valid;
    `);

    await client.query(`
      ALTER TABLE packages
      ADD CONSTRAINT packages_cost_values_valid
      CHECK (
        delivery_cost >= 0
        AND packaging_cost >= 0
        AND other_cost >= 0
      );
    `);

    // ================================================
    // ORDER COST SNAPSHOT
    // Preserve historical order snapshots.
    // Only ensure the column exists.
    // Never rewrite existing snapshots.
    // ================================================

    await client.query(`
      ALTER TABLE order_items
      ADD COLUMN IF NOT EXISTS cost_snapshot JSONB
      NOT NULL DEFAULT '{}'::jsonb;
    `);

    await client.query("COMMIT");

    console.log("Product cost migration completed.");
    console.log("Package cost migration completed.");
    console.log("Existing order snapshots preserved.");

  } catch (error) {
    await client.query("ROLLBACK");

    console.error(
      "Product cost migration failed:",
      error.message
    );

    throw error;

  } finally {
    client.release();
  }
}

module.exports = {
  runProductCostMigration
};
