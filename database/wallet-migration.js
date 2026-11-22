"use strict";

const pool = require("../config/database");

async function runWalletMigration() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // =====================================================
    // WALLET TRANSACTION SAFETY COLUMNS
    // Existing transaction rows and wallet balances remain.
    // balance_effect is nullable for legacy rows whose
    // direction cannot be safely inferred (e.g. adjustments).
    // =====================================================

    await client.query(`
      ALTER TABLE wallet_transactions
      ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(150),
      ADD COLUMN IF NOT EXISTS balance_effect SMALLINT;
    `);

    // Backfill only transaction types with an unambiguous
    // balance direction. Do not guess legacy adjustments.
    await client.query(`
      UPDATE wallet_transactions
      SET balance_effect = CASE
        WHEN transaction_type IN ('deposit', 'refund', 'commission')
          THEN 1
        WHEN transaction_type IN ('withdrawal', 'purchase')
          THEN -1
        ELSE NULL
      END
      WHERE balance_effect IS NULL
        AND transaction_type IN (
          'deposit', 'refund', 'commission',
          'withdrawal', 'purchase'
        );
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
      idx_wallet_transactions_idempotency_unique
      ON wallet_transactions(idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    `);

    await client.query(`
      ALTER TABLE wallet_transactions
      DROP CONSTRAINT IF EXISTS wallet_transactions_balance_effect_valid;
    `);

    await client.query(`
      ALTER TABLE wallet_transactions
      ADD CONSTRAINT wallet_transactions_balance_effect_valid
      CHECK (balance_effect IS NULL OR balance_effect IN (-1, 1));
    `);

    // Ensure transaction type supports all types used by the
    // current wallet and commission routes.
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

    // =====================================================
    // MEMBER DEPOSIT REQUESTS
    // Deposit requests do not credit a wallet until Admin
    // approves them through the wallet API.
    // =====================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS wallet_deposit_requests (
        id BIGSERIAL PRIMARY KEY,

        user_id BIGINT NOT NULL REFERENCES users(id),
        wallet_id BIGINT NOT NULL REFERENCES wallets(id),

        request_reference VARCHAR(100) NOT NULL UNIQUE,
        idempotency_key VARCHAR(150) NOT NULL UNIQUE,

        gateway VARCHAR(30) NOT NULL,
        transaction_reference VARCHAR(180) NOT NULL UNIQUE,

        amount NUMERIC(14, 2) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',

        admin_note TEXT,
        processed_by BIGINT REFERENCES users(id),

        approved_at TIMESTAMPTZ,
        rejected_at TIMESTAMPTZ,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT wallet_deposit_amount_positive
          CHECK (amount > 0),

        CONSTRAINT wallet_deposit_gateway_valid
          CHECK (
            gateway IN (
              'bkash', 'nagad', 'rocket',
              'upay', 'muktopay', 'usdt_bep20'
            )
          ),

        CONSTRAINT wallet_deposit_status_valid
          CHECK (status IN ('pending', 'approved', 'rejected'))
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_wallet_deposit_user_created
      ON wallet_deposit_requests(user_id, created_at DESC);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_wallet_deposit_status_created
      ON wallet_deposit_requests(status, created_at DESC);
    `);

    // =====================================================
    // MEMBER WITHDRAWAL REQUESTS
    // Amount is reserved from the wallet when submitted.
    // Full account number is stored encrypted; normal list
    // endpoints expose only the masked value.
    // =====================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS withdrawal_requests (
        id BIGSERIAL PRIMARY KEY,

        user_id BIGINT NOT NULL REFERENCES users(id),
        wallet_id BIGINT NOT NULL REFERENCES wallets(id),

        request_reference VARCHAR(100) NOT NULL UNIQUE,
        idempotency_key VARCHAR(150) NOT NULL UNIQUE,

        amount NUMERIC(14, 2) NOT NULL,
        fee NUMERIC(14, 2) NOT NULL DEFAULT 0,
        net_amount NUMERIC(14, 2) NOT NULL,

        payment_method VARCHAR(30) NOT NULL,
        account_name VARCHAR(150) NOT NULL,
        account_number_encrypted TEXT NOT NULL,
        account_number_masked VARCHAR(100) NOT NULL,

        status VARCHAR(20) NOT NULL DEFAULT 'pending',

        wallet_transaction_id BIGINT
          REFERENCES wallet_transactions(id),

        admin_note TEXT,
        payment_reference VARCHAR(150),

        processed_by BIGINT REFERENCES users(id),

        requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        approved_at TIMESTAMPTZ,
        processing_at TIMESTAMPTZ,
        paid_at TIMESTAMPTZ,
        rejected_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT withdrawal_amounts_valid
          CHECK (
            amount > 0
            AND fee >= 0
            AND net_amount >= 0
            AND net_amount = amount - fee
            AND fee <= amount
          ),

        CONSTRAINT withdrawal_method_valid
          CHECK (
            payment_method IN ('bkash', 'nagad', 'rocket', 'bank')
          ),

        CONSTRAINT withdrawal_status_valid
          CHECK (
            status IN (
              'pending', 'approved', 'processing',
              'paid', 'rejected'
            )
          )
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_withdrawal_user_requested
      ON withdrawal_requests(user_id, requested_at DESC);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_withdrawal_status_requested
      ON withdrawal_requests(status, requested_at DESC);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_withdrawal_wallet
      ON withdrawal_requests(wallet_id);
    `);

    await client.query("COMMIT");

    console.log("Wallet migration completed.");
    console.log("Deposit and withdrawal request tables checked.");
    console.log("Existing wallet balances and transaction rows preserved.");

  } catch (error) {
    await client.query("ROLLBACK");

    console.error(
      "Wallet migration failed:",
      error.message
    );

    throw error;

  } finally {
    client.release();
  }
}

module.exports = {
  runWalletMigration
};
