
"use strict";

const pool = require("../config/database");

async function runWalletManagementMigration() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // =================================================
    // WALLET TRANSACTION LEDGER EXTENSIONS
    // =================================================

    await client.query(`
      ALTER TABLE wallet_transactions
      ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(150),
      ADD COLUMN IF NOT EXISTS balance_effect SMALLINT
        NOT NULL DEFAULT 0;
    `);

    // Existing transaction types: infer their balance effect.
    await client.query(`
      UPDATE wallet_transactions
      SET balance_effect = CASE
        WHEN transaction_type IN (
          'deposit',
          'commission',
          'refund'
        ) THEN 1

        WHEN transaction_type IN (
          'purchase',
          'withdrawal',
          'commission_reversal'
        ) THEN -1

        ELSE 0
      END
      WHERE balance_effect = 0
        AND status = 'completed';
    `);

    await client.query(`
      ALTER TABLE wallet_transactions
      DROP CONSTRAINT IF EXISTS wallet_transactions_balance_effect_valid;
    `);

    await client.query(`
      ALTER TABLE wallet_transactions
      ADD CONSTRAINT wallet_transactions_balance_effect_valid
      CHECK (balance_effect IN (-1, 0, 1));
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
      idx_wallet_transactions_idempotency
      ON wallet_transactions(idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS
      idx_wallet_transactions_wallet_ledger
      ON wallet_transactions(wallet_id, status, created_at);
    `);

    // =================================================
    // WITHDRAWAL REQUESTS
    // =================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS withdrawal_requests (
        id BIGSERIAL PRIMARY KEY,

        user_id BIGINT NOT NULL
          REFERENCES users(id),

        wallet_id BIGINT NOT NULL
          REFERENCES wallets(id),

        request_reference VARCHAR(70) NOT NULL UNIQUE,

        idempotency_key VARCHAR(150) NOT NULL UNIQUE,

        amount NUMERIC(14,2) NOT NULL,

        fee NUMERIC(14,2) NOT NULL DEFAULT 0,

        net_amount NUMERIC(14,2) NOT NULL,

        payment_method VARCHAR(40) NOT NULL,

        account_name VARCHAR(150) NOT NULL,

        account_number_encrypted TEXT NOT NULL,

        account_number_masked VARCHAR(80) NOT NULL,

        status VARCHAR(20) NOT NULL DEFAULT 'pending',

        admin_note TEXT,

        payment_reference VARCHAR(150),

        requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        approved_at TIMESTAMPTZ,

        processing_at TIMESTAMPTZ,

        paid_at TIMESTAMPTZ,

        rejected_at TIMESTAMPTZ,

        processed_by BIGINT
          REFERENCES users(id),

        wallet_transaction_id BIGINT
          REFERENCES wallet_transactions(id),

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT withdrawal_amount_valid
          CHECK (amount > 0),

        CONSTRAINT withdrawal_fee_valid
          CHECK (fee >= 0 AND fee <= amount),

        CONSTRAINT withdrawal_net_valid
          CHECK (net_amount >= 0),

        CONSTRAINT withdrawal_status_valid
          CHECK (
            status IN (
              'pending',
              'approved',
              'processing',
              'paid',
              'rejected'
            )
          )
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS
      idx_withdrawal_requests_user
      ON withdrawal_requests(user_id, created_at DESC);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS
      idx_withdrawal_requests_status
      ON withdrawal_requests(status, created_at DESC);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS
      idx_withdrawal_requests_wallet
      ON withdrawal_requests(wallet_id, status);
    `);

    // =================================================
    // WALLET RECONCILIATION AUDIT LOG
    // =================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS wallet_reconciliation_logs (
        id BIGSERIAL PRIMARY KEY,

        wallet_id BIGINT NOT NULL
          REFERENCES wallets(id),

        recorded_balance NUMERIC(14,2) NOT NULL,

        ledger_balance NUMERIC(14,2) NOT NULL,

        difference NUMERIC(14,2) NOT NULL,

        status VARCHAR(20) NOT NULL,

        checked_by BIGINT
          REFERENCES users(id),

        note TEXT,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT wallet_reconciliation_status_valid
          CHECK (status IN ('matched', 'mismatch'))
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS
      idx_wallet_reconciliation_wallet
      ON wallet_reconciliation_logs(wallet_id, created_at DESC);
    `);

    // =================================================
    // MIGRATION COMPLETE
    // =================================================

    await client.query("COMMIT");

    console.log("Wallet management migration completed.");
    console.log("Withdrawal request table checked.");
    console.log("Wallet ledger extensions checked.");
    console.log("Wallet reconciliation log checked.");

  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;

  } finally {
    client.release();
  }
}

module.exports = {
  runWalletManagementMigration
};
