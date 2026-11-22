
-- =====================================================
-- RUBALIA NETWORK
-- COMMISSION ENGINE DATABASE
-- 10 LEVEL UNILEVEL COMMISSION SYSTEM
-- =====================================================

-- 1. PRODUCT COST FIELDS

ALTER TABLE products
ADD COLUMN IF NOT EXISTS cost_price NUMERIC(12,2) NOT NULL DEFAULT 0;

ALTER TABLE products
ADD COLUMN IF NOT EXISTS delivery_cost NUMERIC(12,2) NOT NULL DEFAULT 0;

ALTER TABLE products
ADD COLUMN IF NOT EXISTS packaging_cost NUMERIC(12,2) NOT NULL DEFAULT 0;

ALTER TABLE products
ADD COLUMN IF NOT EXISTS other_cost NUMERIC(12,2) NOT NULL DEFAULT 0;


-- 2. PACKAGE COST FIELDS

ALTER TABLE packages
ADD COLUMN IF NOT EXISTS delivery_cost NUMERIC(12,2) NOT NULL DEFAULT 0;

ALTER TABLE packages
ADD COLUMN IF NOT EXISTS packaging_cost NUMERIC(12,2) NOT NULL DEFAULT 0;

ALTER TABLE packages
ADD COLUMN IF NOT EXISTS other_cost NUMERIC(12,2) NOT NULL DEFAULT 0;


-- 3. ORDER ITEM COST SNAPSHOT
-- Product/package cost at the time of order creation.
-- This must not change when Admin edits product costs later.

ALTER TABLE order_items
ADD COLUMN IF NOT EXISTS cost_snapshot JSONB;


-- 4. COMMISSION SETTINGS

CREATE TABLE IF NOT EXISTS commission_settings (
    id SMALLINT PRIMARY KEY CHECK (id = 1),

    enabled BOOLEAN NOT NULL DEFAULT FALSE,

    legal_approval_confirmed BOOLEAN NOT NULL DEFAULT FALSE,

    gateway_fee_percent NUMERIC(7,4) NOT NULL DEFAULT 0,

    level_rates JSONB NOT NULL DEFAULT
    '[20,15,10,8,6,5,4,3,2,2]'::jsonb,

    updated_by BIGINT REFERENCES users(id),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (
        gateway_fee_percent >= 0
        AND gateway_fee_percent <= 100
    )
);

INSERT INTO commission_settings (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;


-- 5. MEMBER COMMISSION LEDGER

CREATE TABLE IF NOT EXISTS commission_ledger (
    id BIGSERIAL PRIMARY KEY,

    order_id BIGINT NOT NULL
        REFERENCES orders(id),

    beneficiary_id BIGINT
        REFERENCES users(id),

    level SMALLINT NOT NULL
        CHECK (level BETWEEN 1 AND 10),

    rate_percent NUMERIC(7,4) NOT NULL,

    profit_base NUMERIC(14,2) NOT NULL,

    amount NUMERIC(14,2) NOT NULL,

    status VARCHAR(20) NOT NULL DEFAULT 'pending',

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(order_id, level),

    CHECK (rate_percent >= 0),

    CHECK (amount >= 0),

    CHECK (
        status IN (
            'pending',
            'credited',
            'unallocated',
            'reversed'
        )
    )
);


-- Update an existing commission ledger status constraint.
-- The service requires pending before releasing wallet credits.

ALTER TABLE commission_ledger
DROP CONSTRAINT IF EXISTS commission_ledger_status_check;

ALTER TABLE commission_ledger
ADD CONSTRAINT commission_ledger_status_check
CHECK (
    status IN (
        'pending',
        'credited',
        'unallocated',
        'reversed'
    )
);


CREATE INDEX IF NOT EXISTS
idx_commission_ledger_beneficiary
ON commission_ledger(
    beneficiary_id,
    created_at DESC
);

CREATE INDEX IF NOT EXISTS
idx_commission_ledger_order
ON commission_ledger(order_id);


-- 6. COMPANY PROFIT LEDGER

CREATE TABLE IF NOT EXISTS company_profit_ledger (
    id BIGSERIAL PRIMARY KEY,

    order_id BIGINT NOT NULL UNIQUE
        REFERENCES orders(id),

    gross_profit NUMERIC(14,2) NOT NULL,

    company_share NUMERIC(14,2) NOT NULL,

    unallocated_commission NUMERIC(14,2) NOT NULL DEFAULT 0,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (gross_profit >= 0),

    CHECK (company_share >= 0),

    CHECK (unallocated_commission >= 0)
);


-- 7. WALLET TRANSACTION TYPE
-- Add commission as a supported transaction type.

ALTER TABLE wallet_transactions
DROP CONSTRAINT IF EXISTS wallet_transaction_type_valid;

ALTER TABLE wallet_transactions
DROP CONSTRAINT IF EXISTS wallet_transactions_transaction_type_check;

ALTER TABLE wallet_transactions
ADD CONSTRAINT wallet_transaction_type_valid
CHECK (
    transaction_type IN (
        'deposit',
        'withdrawal',
        'purchase',
        'refund',
        'adjustment',
        'commission'
    )
);


-- =====================================================
-- DATABASE MIGRATION COMPLETED
-- Existing user and wallet data are preserved.
-- =====================================================
