
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

      CONSTRAINT products_price_nonnegative
        CHECK (price >= 0),

      CONSTRAINT products_stock_nonnegative
        CHECK (stock >= 0),

      CONSTRAINT products_status_valid
        CHECK (status IN ('draft', 'active', 'archived'))
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_products_status
    ON products(status);
  `);


  // PACKAGES
  // Every package contains exactly three different products.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS packages (
      id BIGSERIAL PRIMARY KEY,

      name VARCHAR(180) NOT NULL,
      category VARCHAR(100),
      description TEXT,
      image_url TEXT,

      product_1_id BIGINT NOT NULL REFERENCES products(id),
      product_2_id BIGINT NOT NULL REFERENCES products(id),
      product_3_id BIGINT NOT NULL REFERENCES products(id),

      price NUMERIC(12, 2) NOT NULL DEFAULT 0,
      stock INTEGER NOT NULL DEFAULT 0,

      status VARCHAR(20) NOT NULL DEFAULT 'draft',

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT packages_price_nonnegative
        CHECK (price >= 0),

      CONSTRAINT packages_stock_nonnegative
        CHECK (stock >= 0),

      CONSTRAINT packages_three_different_products
        CHECK (
          product_1_id <> product_2_id
          AND product_1_id <> product_3_id
          AND product_2_id <> product_3_id
        ),

      CONSTRAINT packages_status_valid
        CHECK (
          status IN ('draft', 'active', 'inactive', 'archived')
        )
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_packages_status
    ON packages(status);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_packages_category
    ON packages(category);
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

      CONSTRAINT orders_amount_nonnegative
        CHECK (total_amount >= 0),

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
  // Supports both individual products and packages.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_items (
      id BIGSERIAL PRIMARY KEY,

      order_id BIGINT NOT NULL
        REFERENCES orders(id),

      product_id BIGINT
        REFERENCES products(id),

      package_id BIGINT
        REFERENCES packages(id),

      item_type VARCHAR(20) NOT NULL DEFAULT 'product',

      product_name VARCHAR(180) NOT NULL,

      unit_price NUMERIC(12, 2) NOT NULL,
      quantity INTEGER NOT NULL,
      subtotal NUMERIC(12, 2) NOT NULL,

      CONSTRAINT order_items_price_nonnegative
        CHECK (unit_price >= 0),

      CONSTRAINT order_items_quantity_positive
        CHECK (quantity > 0),

      CONSTRAINT order_items_subtotal_nonnegative
        CHECK (subtotal >= 0),

      CONSTRAINT order_items_type_valid
        CHECK (item_type IN ('product', 'package')),

      CONSTRAINT order_items_reference_valid
        CHECK (
          (item_type = 'product'
            AND product_id IS NOT NULL
            AND package_id IS NULL)
          OR
          (item_type = 'package'
            AND package_id IS NOT NULL
            AND product_id IS NULL)
        )
    );
  `);


  // SAFE MIGRATION FOR EXISTING DATABASES
  // Existing product orders are preserved.

  await pool.query(`
    ALTER TABLE order_items
    ADD COLUMN IF NOT EXISTS package_id BIGINT
    REFERENCES packages(id);
  `);

  await pool.query(`
    ALTER TABLE order_items
    ADD COLUMN IF NOT EXISTS item_type VARCHAR(20)
    NOT NULL DEFAULT 'product';
  `);

  // Old product_id was NOT NULL.
  // Package orders do not require a product_id.
  await pool.query(`
    ALTER TABLE order_items
    ALTER COLUMN product_id DROP NOT NULL;
  `);

  // Add validation constraints to existing databases.
  // The migration checks whether each constraint already exists.

  await pool.query(`
    DO $$
    BEGIN

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'order_items_type_valid'
          AND conrelid = 'order_items'::regclass
      ) THEN
        ALTER TABLE order_items
        ADD CONSTRAINT order_items_type_valid
        CHECK (item_type IN ('product', 'package'));
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'order_items_reference_valid'
          AND conrelid = 'order_items'::regclass
      ) THEN
        ALTER TABLE order_items
        ADD CONSTRAINT order_items_reference_valid
        CHECK (
          (item_type = 'product'
            AND product_id IS NOT NULL
            AND package_id IS NULL)
          OR
          (item_type = 'package'
            AND package_id IS NOT NULL
            AND product_id IS NULL)
        );
      END IF;

    END $$;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_order_items_order_id
    ON order_items(order_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_order_items_package_id
    ON order_items(package_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_order_items_item_type
    ON order_items(item_type);
  `);


  // WALLETS
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallets (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL UNIQUE REFERENCES users(id),
      balance NUMERIC(14, 2) NOT NULL DEFAULT 0,
      currency VARCHAR(3) NOT NULL DEFAULT 'BDT',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT wallets_balance_nonnegative
        CHECK (balance >= 0)
    );
  `);


  // WALLET TRANSACTIONS
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id BIGSERIAL PRIMARY KEY,
      wallet_id BIGINT NOT NULL REFERENCES wallets(id),
      transaction_type VARCHAR(30) NOT NULL,
      amount NUMERIC(14, 2) NOT NULL,
      reference VARCHAR(100) UNIQUE,
      description TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT wallet_transaction_amount_positive
        CHECK (amount > 0),

      CONSTRAINT wallet_transaction_type_valid CHECK (
        transaction_type IN (
          'deposit',
          'withdrawal',
          'purchase',
          'refund',
          'adjustment'
        )
      ),

      CONSTRAINT wallet_transaction_status_valid CHECK (
        status IN (
          'pending',
          'approved',
          'rejected',
          'completed'
        )
      )
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_wallet_transactions_wallet_id
    ON wallet_transactions(wallet_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_wallet_transactions_created_at
    ON wallet_transactions(created_at DESC);
  `);


  // NOTIFICATIONS
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL
        REFERENCES users(id) ON DELETE CASCADE,
      title VARCHAR(180) NOT NULL,
      message TEXT NOT NULL,
      notification_type VARCHAR(40) NOT NULL DEFAULT 'general',
      is_read BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_notifications_user_created
    ON notifications(user_id, created_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_notifications_unread
    ON notifications(user_id, is_read)
    WHERE is_read = FALSE;
  `);


  console.log("Database initialization and migrations completed.");
}

module.exports = { initializeDatabase };
