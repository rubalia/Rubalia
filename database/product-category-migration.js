"use strict";

const pool = require("../config/database");

async function runProductCategoryMigration() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // ================================================
    // ADD PRODUCT CATEGORY COLUMN
    // Existing products will be preserved.
    // ================================================

    await client.query(`
      ALTER TABLE products
      ADD COLUMN IF NOT EXISTS category VARCHAR(100);
    `);

    // ================================================
    // NORMALIZE EMPTY CATEGORY VALUES
    // ================================================

    await client.query(`
      UPDATE products
      SET category = NULL
      WHERE category IS NOT NULL
        AND TRIM(category) = '';
    `);

    // ================================================
    // CATEGORY INDEX
    // Helps category filtering and searching.
    // ================================================

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_products_category
      ON products(category);
    `);

    // ================================================
    // CATEGORY VALIDATION
    // Category may remain NULL for old products.
    // ================================================

    await client.query(`
      ALTER TABLE products
      DROP CONSTRAINT IF EXISTS products_category_valid;
    `);

    await client.query(`
      ALTER TABLE products
      ADD CONSTRAINT products_category_valid
      CHECK (
        category IS NULL
        OR (
          LENGTH(TRIM(category)) > 0
          AND LENGTH(category) <= 100
        )
      );
    `);

    await client.query("COMMIT");

    console.log("Product category migration completed.");
    console.log("Existing products and stock preserved.");
    console.log("Product category index created.");

  } catch (error) {
    await client.query("ROLLBACK");

    console.error(
      "Product category migration failed:",
      error.message
    );

    throw error;

  } finally {
    client.release();
  }
}

module.exports = {
  runProductCategoryMigration
};
