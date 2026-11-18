const pool = require("../config/database");

async function initializeDatabase() {
  // USERS
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      full_name VARCHAR(120) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role VARCHAR(30) NOT NULL DEFAULT 'customer',
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_users_email
    ON users(email);
  `);

  // SPONSOR RELATIONSHIP
  // Existing users remain unchanged; sponsor_id is initially NULL.
  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS sponsor_id BIGINT
    REFERENCES users(id) ON DELETE SET NULL;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_users_sponsor_id
    ON users(sponsor_id);
  `);

  // PRODUCTS
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(180) NOT NULL,
      sku VARCHAR(80) UNIQUE,
      description TEXT,
      price NUMERIC(12, 2) NOT NULL DEFAULT 0,
      stock INTEGER NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'draft',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT products_price_nonnegative CHECK (price >= 0),
      CONSTRAINT products_stock_nonnegative CHECK (stock >= 0),
      CONSTRAINT products_status_valid
        CHECK (status IN ('draft', 'active', 'archived'))
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_products_status
    ON products(status);
  `);

  // ORDERS
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id),
      order_number VARCHAR(40) UNIQUE NOT NULL,
      total_amount NUMERIC(12, 2) NOT NULL,
      shipping_name VARCHAR(120) NOT NULL,
      shipping_phone VARCHAR(30) NOT NULL,
      shipping_address TEXT NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT orders_amount_nonnegative CHECK (total_amount >= 0),
      CONSTRAINT orders_status_valid CHECK (
        status IN (
          'pending',
          'confirmed',
          'processing',
          'shipped',
          'delivered',
          'cancelled'
        )
      )
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_orders_user_id
    ON orders(user_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_orders_created_at
    ON orders(created_at DESC);
  `);

  // ORDER ITEMS
  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_items (
      id BIGSERIAL PRIMARY KEY,
      order_id BIGINT NOT NULL REFERENCES orders(id),
      product_id BIGINT NOT NULL REFERENCES products(id),
      product_name VARCHAR(180) NOT NULL,
      unit_price NUMERIC(12, 2) NOT NULL,
      quantity INTEGER NOT NULL,
      subtotal NUMERIC(12, 2) NOT NULL,

      CONSTRAINT order_items_price_nonnegative CHECK (unit_price >= 0),
      CONSTRAINT order_items_quantity_positive CHECK (quantity > 0),
      CONSTRAINT order_items_subtotal_nonnegative CHECK (subtotal >= 0)
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_order_items_order_id
    ON order_items(order_id);
  `);

  console.log("Database initialization completed.");
}

module.exports = { initializeDatabase };
