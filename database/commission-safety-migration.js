
"use strict";

const pool = require("../config/database");

async function runCommissionSafetyMigration() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // =================================================
    // COMMISSION SETTINGS
    // =================================================

    await client.query(`
      ALTER TABLE commission_settings
      ADD COLUMN IF NOT EXISTS refund_period_days
      INTEGER NOT NULL DEFAULT 7;
    `);

    await client.query(`
      ALTER TABLE commission_settings
      DROP CONSTRAINT IF EXISTS commission_refund_period_days_valid;
    `);

    await client.query(`
      ALTER TABLE commission_settings
      ADD CONSTRAINT commission_refund_period_days_valid
      CHECK (refund_period_days BETWEEN 0 AND 365);
    `);

    // =================================================
    // ORDER COMMISSION AND REFUND FIELDS
    // =================================================

    await client.query(`
      ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS refund_period_ends_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS commission_status VARCHAR(20)
        NOT NULL DEFAULT 'not_eligible',

      ADD COLUMN IF NOT EXISTS refund_status VARCHAR(20)
        NOT NULL DEFAULT 'not_requested',

      ADD COLUMN IF NOT EXISTS refund_requested_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS refund_confirmed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS refund_confirmed_by BIGINT
        REFERENCES users(id),

      ADD COLUMN IF NOT EXISTS refund_admin_note TEXT;
    `);

    await client.query(`
      ALTER TABLE orders
      DROP CONSTRAINT IF EXISTS orders_commission_status_valid;
    `);

    await client.query(`
      ALTER TABLE orders
      ADD CONSTRAINT orders_commission_status_valid
      CHECK (
        commission_status IN (
          'not_eligible',
          'pending',
          'released',
          'reversed'
        )
      );
    `);

    await client.query(`
      ALTER TABLE orders
      DROP CONSTRAINT IF EXISTS orders_refund_status_valid;
    `);

    await client.query(`
      ALTER TABLE orders
      ADD CONSTRAINT orders_refund_status_valid
      CHECK (
        refund_status IN (
          'not_requested',
          'pending',
          'completed',
          'rejected'
        )
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_orders_commission_maturity
      ON orders(refund_period_ends_at, id)
      WHERE commission_status = 'pending'
        AND status = 'delivered'
        AND payment_status = 'paid';
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_orders_refund_pending
      ON orders(updated_at DESC, id)
      WHERE status = 'cancelled'
        AND refund_status IN ('not_requested', 'pending');
    `);

    // =================================================
    // ORDER COST SNAPSHOT
    // =================================================

    await client.query(`
      ALTER TABLE order_items
      ADD COLUMN IF NOT EXISTS cost_snapshot JSONB
      NOT NULL DEFAULT '{}'::jsonb;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_order_items_cost_snapshot
      ON order_items USING GIN (cost_snapshot);
    `);

    // =================================================
    // COMMISSION LEDGER
    // =================================================

    await client.query(`
      ALTER TABLE commission_ledger
      ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS wallet_transaction_id BIGINT
        REFERENCES wallet_transactions(id);
    `);

    await client.query(`
      ALTER TABLE commission_ledger
      DROP CONSTRAINT IF EXISTS commission_status_valid;
    `);

    await client.query(`
      ALTER TABLE commission_ledger
      ADD CONSTRAINT commission_status_valid
      CHECK (
        status IN (
          'pending',
          'credited',
          'unallocated',
          'reversed'
        )
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_commission_ledger_pending
      ON commission_ledger(order_id, level)
      WHERE status = 'pending';
    `);

    // =================================================
    // WALLET TRANSACTION TYPES
    // =================================================

    await client.query(`
      ALTER TABLE wallet_transactions
      DROP CONSTRAINT IF EXISTS wallet_transaction_type_valid;
    `);

    await client.query(`
      ALTER TABLE wallet_transactions
      DROP CONSTRAINT IF EXISTS wallet_transactions_transaction_type_check;
    `);

    await client.query(`
      ALTER TABLE wallet_transactions
      ADD CONSTRAINT wallet_transaction_type_valid
      CHECK (
        transaction_type IN (
          'deposit',
          'withdrawal',
          'purchase',
          'refund',
          'adjustment',
          'commission',
          'commission_reversal'
        )
      );
    `);

    // =================================================
    // COMMISSION REVERSAL DEBTS
    // =================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS commission_reversal_debts (
        id BIGSERIAL PRIMARY KEY,

        user_id BIGINT NOT NULL REFERENCES users(id),
        order_id BIGINT NOT NULL REFERENCES orders(id),
        commission_ledger_id BIGINT NOT NULL
          REFERENCES commission_ledger(id),

        original_amount NUMERIC(14,2) NOT NULL,
        recovered_amount NUMERIC(14,2) NOT NULL DEFAULT 0,

        status VARCHAR(20) NOT NULL DEFAULT 'open',

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT commission_reversal_debt_amounts_valid
          CHECK (
            original_amount >= 0
            AND recovered_amount >= 0
            AND recovered_amount <= original_amount
          ),

        CONSTRAINT commission_reversal_debt_status_valid
          CHECK (
            status IN (
              'open',
              'partially_recovered',
              'recovered'
            )
          ),

        CONSTRAINT commission_reversal_debt_ledger_unique
          UNIQUE(commission_ledger_id)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_commission_reversal_debts_user
      ON commission_reversal_debts(user_id, status, created_at);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_commission_reversal_debts_order
      ON commission_reversal_debts(order_id);
    `);

    // =================================================
    // REFUND TRANSACTION DUPLICATE PROTECTION
    //
    // A single order can have only one completed refund
    // transaction with this reference.
    // =================================================

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
      idx_wallet_transactions_unique_order_refund
      ON wallet_transactions(reference)
      WHERE transaction_type = 'refund'
        AND reference LIKE 'REFUND-ORDER-%';
    `);

    await client.query("COMMIT");

    console.log("Commission safety migration completed.");
    console.log("Refund workflow migration completed.");
    console.log("Existing financial records and wallet balances preserved.");

  } catch (error) {
    await client.query("ROLLBACK");

    console.error(
      "Commission safety migration failed:",
      error.message
    );

    throw error;

  } finally {
    client.release();
  }
}

module.exports = {
  runCommissionSafetyMigration
};
