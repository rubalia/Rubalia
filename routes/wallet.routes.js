
"use strict";

const express = require("express");
const crypto = require("crypto");

const pool = require("../config/database");
const { authenticateToken } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/admin");
const { sendAdminPush } = require("../services/admin-push");

const router = express.Router();

const MIN_WITHDRAWAL = Number(process.env.MIN_WITHDRAWAL || 100);
const MAX_WITHDRAWAL = Number(process.env.MAX_WITHDRAWAL || 100000);
const WITHDRAWAL_FEE = Number(process.env.WITHDRAWAL_FEE || 0);

const DEPOSIT_METHODS = [
  "bkash",
  "nagad",
  "rocket",
  "upay",
  "muktopay",
  "usdt_bep20"
];

const WITHDRAWAL_METHODS = [
  "bkash",
  "nagad",
  "rocket",
  "bank"
];

const ENCRYPTION_KEY = process.env.WALLET_ENCRYPTION_KEY || "";

// =====================================================
// MONEY HELPERS
// =====================================================

function moneyCents(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    throw new Error("Invalid monetary value.");
  }

  return Math.round(number * 100);
}

function centsMoney(cents) {
  return (cents / 100).toFixed(2);
}

function validAmount(value) {
  const amount = Number(value);

  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  const cents = moneyCents(amount);

  if (cents <= 0 || centsMoney(cents) !== amount.toFixed(2)) {
    return null;
  }

  return cents;
}

function makeReference(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
}

function getIdempotencyKey(req) {
  const value =
    req.get("Idempotency-Key") ||
    req.body?.idempotency_key ||
    "";

  if (
    typeof value !== "string" ||
    value.length < 8 ||
    value.length > 150
  ) {
    return null;
  }

  return value.trim();
}

// =====================================================
// ACCOUNT ENCRYPTION
// =====================================================

function isEncryptionKeyValid() {
  return /^[a-fA-F0-9]{64}$/.test(ENCRYPTION_KEY);
}

function encryptAccountNumber(value) {
  if (!isEncryptionKeyValid()) {
    throw new Error(
      "WALLET_ENCRYPTION_KEY must be a 64-character hexadecimal key."
    );
  }

  const iv = crypto.randomBytes(12);
  const key = Buffer.from(ENCRYPTION_KEY, "hex");

  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    key,
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final()
  ]);

  const tag = cipher.getAuthTag();

  return [
    iv.toString("hex"),
    tag.toString("hex"),
    encrypted.toString("hex")
  ].join(":");
}

function decryptAccountNumber(value) {
  if (!isEncryptionKeyValid()) {
    throw new Error("Wallet encryption key is not configured.");
  }

  const parts = String(value || "").split(":");

  if (parts.length !== 3) {
    throw new Error("Invalid encrypted account data.");
  }

  const [ivHex, tagHex, encryptedHex] = parts;

  if (
    !/^[a-fA-F0-9]{24}$/.test(ivHex) ||
    !/^[a-fA-F0-9]{32}$/.test(tagHex) ||
    !/^(?:[a-fA-F0-9]{2})+$/.test(encryptedHex)
  ) {
    throw new Error("Invalid encrypted account data.");
  }

  const key = Buffer.from(ENCRYPTION_KEY, "hex");

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivHex, "hex")
  );

  decipher.setAuthTag(Buffer.from(tagHex, "hex"));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, "hex")),
    decipher.final()
  ]).toString("utf8");
}

function maskAccount(value) {
  const text = String(value);

  if (text.length <= 4) {
    return "*".repeat(text.length);
  }

  return `${"*".repeat(Math.max(4, text.length - 4))}${text.slice(-4)}`;
}

// =====================================================
// WALLET HELPERS
// =====================================================

async function getOrCreateWallet(client, userId) {
  const result = await client.query(
    `INSERT INTO wallets (user_id)
     VALUES ($1)
     ON CONFLICT (user_id)
     DO UPDATE SET user_id = EXCLUDED.user_id
     RETURNING id, user_id, balance, currency, created_at, updated_at`,
    [userId]
  );

  return result.rows[0];
}

async function findExistingRequest(client, table, key) {
  const allowedTables = [
    "wallet_deposit_requests",
    "withdrawal_requests"
  ];

  if (!allowedTables.includes(table)) {
    throw new Error("Invalid request table.");
  }

  const result = await client.query(
    `SELECT *
     FROM ${table}
     WHERE idempotency_key = $1
     LIMIT 1`,
    [key]
  );

  return result.rows[0] || null;
}

async function createLedgerTransaction(client, data) {
  const result = await client.query(
    `INSERT INTO wallet_transactions (
       wallet_id,
       transaction_type,
       amount,
       reference,
       description,
       status,
       idempotency_key,
       balance_effect
     )
     VALUES ($1, $2, $3, $4, $5, 'completed', $6, $7)
     ON CONFLICT (idempotency_key)
       WHERE idempotency_key IS NOT NULL
     DO NOTHING
     RETURNING *`,
    [
      data.walletId,
      data.type,
      centsMoney(data.amountCents),
      data.reference,
      data.description,
      data.idempotencyKey,
      data.balanceEffect
    ]
  );

  return result.rows[0] || null;
}

// Safe response for duplicate withdrawal requests.
// Never expose encrypted account data or database internals.
function safeWithdrawalResponse(request) {
  return {
    id: request.id,
    request_reference: request.request_reference,
    amount: request.amount,
    fee: request.fee,
    net_amount: request.net_amount,
    payment_method: request.payment_method,
    account_name: request.account_name,
    account_number_masked: request.account_number_masked,
    status: request.status,
    requested_at: request.requested_at
  };
}

// =====================================================
// MEMBER WALLET
// GET /api/wallet
// =====================================================

router.get("/", authenticateToken, async (req, res, next) => {
  try {
    const wallet = await getOrCreateWallet(pool, req.auth.id);

    return res.json({
      success: true,
      wallet
    });
  } catch (error) {
    next(error);
  }
});

// =====================================================
// GET WALLET TRANSACTIONS
// GET /api/wallet/transactions
// =====================================================

router.get(
  "/transactions",
  authenticateToken,
  async (req, res, next) => {
    try {
      const walletResult = await pool.query(
        `SELECT id
         FROM wallets
         WHERE user_id = $1`,
        [req.auth.id]
      );

      if (!walletResult.rowCount) {
        return res.json({
          success: true,
          transactions: []
        });
      }

      const result = await pool.query(
        `SELECT
           id,
           transaction_type,
           amount,
           reference,
           description,
           status,
           balance_effect,
           created_at
         FROM wallet_transactions
         WHERE wallet_id = $1
         ORDER BY created_at DESC
         LIMIT 100`,
        [walletResult.rows[0].id]
      );

      return res.json({
        success: true,
        transactions: result.rows
      });
    } catch (error) {
      next(error);
    }
  }
);

// =====================================================
// DEPOSIT METHODS
// GET /api/wallet/deposit-methods
// =====================================================

router.get(
  "/deposit-methods",
  authenticateToken,
  async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT
           gateway,
           display_name,
           instructions,
           account_number,
           wallet_address,
           network,
           usdt_rate
         FROM payment_gateway_settings
         WHERE enabled = TRUE
         ORDER BY display_name ASC`
      );

      return res.json({
        success: true,
        methods: result.rows
      });
    } catch (error) {
      next(error);
    }
  }
);

// =====================================================
// MEMBER DEPOSIT REQUEST
// POST /api/wallet/deposit
// =====================================================

router.post(
  "/deposit",
  authenticateToken,
  async (req, res, next) => {
    const amountCents = validAmount(req.body.amount);

    const gateway = String(
      req.body.gateway || ""
    ).trim().toLowerCase();

    const transactionReference = String(
      req.body.transaction_reference || ""
    ).trim();

    const idempotencyKey = getIdempotencyKey(req);

    if (!amountCents || amountCents < 1000) {
      return res.status(400).json({
        success: false,
        message: "Minimum deposit amount is 10.00."
      });
    }

    if (!DEPOSIT_METHODS.includes(gateway)) {
      return res.status(400).json({
        success: false,
        message: "Invalid deposit method."
      });
    }

    if (
      transactionReference.length < 5 ||
      transactionReference.length > 180
    ) {
      return res.status(400).json({
        success: false,
        message: "Valid transaction reference is required."
      });
    }

    if (!idempotencyKey) {
      return res.status(400).json({
        success: false,
        message: "Idempotency-Key header is required."
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const existing = await findExistingRequest(
        client,
        "wallet_deposit_requests",
        idempotencyKey
      );

      if (existing) {
        await client.query("COMMIT");

        return res.json({
          success: true,
          duplicate: true,
          request: {
            id: existing.id,
            request_reference: existing.request_reference,
            gateway: existing.gateway,
            transaction_reference: existing.transaction_reference,
            amount: existing.amount,
            status: existing.status,
            created_at: existing.created_at
          }
        });
      }

      const methodResult = await client.query(
        `SELECT gateway
         FROM payment_gateway_settings
         WHERE gateway = $1
           AND enabled = TRUE`,
        [gateway]
      );

      if (!methodResult.rowCount) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message: "This deposit method is currently unavailable."
        });
      }

      const wallet = await getOrCreateWallet(
        client,
        req.auth.id
      );

      const reference = makeReference("DEP");

      const result = await client.query(
        `INSERT INTO wallet_deposit_requests (
           user_id,
           wallet_id,
           request_reference,
           idempotency_key,
           gateway,
           transaction_reference,
           amount,
           status
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
         RETURNING
           id,
           request_reference,
           gateway,
           transaction_reference,
           amount,
           status,
           created_at`,
        [
          req.auth.id,
          wallet.id,
          reference,
          idempotencyKey,
          gateway,
          transactionReference,
          centsMoney(amountCents)
        ]
      );

      await client.query("COMMIT");

      // Notify Admin after successful deposit request.
      sendAdminPush("new_deposit", {
        reference: reference,
        message: `A new deposit request of ${centsMoney(amountCents)} has been submitted.`
      }).catch(error => {
        console.error("New deposit Admin push failed:", error.message);
      });

      return res.status(201).json({
        success: true,
        message: "Deposit request submitted. Waiting for Admin verification.",
        request: result.rows[0]
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});

      if (error.code === "23505") {
        return res.status(409).json({
          success: false,
          message: "This payment reference or request has already been submitted."
        });
      }

      next(error);
    } finally {
      client.release();
    }
  }
);

// =====================================================
// MEMBER DEPOSIT HISTORY
// GET /api/wallet/deposits
// =====================================================

router.get(
  "/deposits",
  authenticateToken,
  async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT
           id,
           request_reference,
           gateway,
           transaction_reference,
           amount,
           status,
           admin_note,
           created_at,
           updated_at
         FROM wallet_deposit_requests
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 100`,
        [req.auth.id]
      );

      return res.json({
        success: true,
        deposits: result.rows
      });
    } catch (error) {
      next(error);
    }
  }
);

// =====================================================
// MEMBER WITHDRAWAL REQUEST
// POST /api/wallet/withdraw
// =====================================================

router.post(
  "/withdraw",
  authenticateToken,
  async (req, res, next) => {
    const amountCents = validAmount(req.body.amount);

    const method = String(
      req.body.payment_method || ""
    ).trim().toLowerCase();

    const accountName = String(
      req.body.account_name || ""
    ).trim();

    const accountNumber = String(
      req.body.account_number || ""
    ).trim();

    const idempotencyKey = getIdempotencyKey(req);

    if (
      !amountCents ||
      amountCents < moneyCents(MIN_WITHDRAWAL) ||
      amountCents > moneyCents(MAX_WITHDRAWAL)
    ) {
      return res.status(400).json({
        success: false,
        message: `Withdrawal must be between ${MIN_WITHDRAWAL} and ${MAX_WITHDRAWAL}.`
      });
    }

    if (!WITHDRAWAL_METHODS.includes(method)) {
      return res.status(400).json({
        success: false,
        message: "Invalid withdrawal method."
      });
    }

    if (
      accountName.length < 2 ||
      accountName.length > 150 ||
      accountNumber.length < 5 ||
      accountNumber.length > 100
    ) {
      return res.status(400).json({
        success: false,
        message: "Valid account name and account number are required."
      });
    }

    if (!idempotencyKey) {
      return res.status(400).json({
        success: false,
        message: "Idempotency-Key header is required."
      });
    }

    let encryptedAccount;

    try {
      encryptedAccount = encryptAccountNumber(accountNumber);
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: error.message
      });
    }

    const feeCents = moneyCents(WITHDRAWAL_FEE);

    if (feeCents < 0 || feeCents > amountCents) {
      return res.status(500).json({
        success: false,
        message: "Invalid withdrawal fee configuration."
      });
    }

    const netCents = amountCents - feeCents;
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const existing = await findExistingRequest(
        client,
        "withdrawal_requests",
        idempotencyKey
      );

      if (existing) {
        await client.query("COMMIT");

        return res.json({
          success: true,
          duplicate: true,
          request: safeWithdrawalResponse(existing)
        });
      }

      const wallet = await getOrCreateWallet(
        client,
        req.auth.id
      );

      const lockedWallet = await client.query(
        `SELECT id, balance
         FROM wallets
         WHERE id = $1
         FOR UPDATE`,
        [wallet.id]
      );

      const balanceCents = moneyCents(
        lockedWallet.rows[0].balance
      );

      if (balanceCents < amountCents) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message: "Insufficient wallet balance."
        });
      }

      const reference = makeReference("WDR");

      const ledger = await createLedgerTransaction(client, {
        walletId: wallet.id,
        type: "withdrawal",
        amountCents,
        reference,
        description: "Wallet withdrawal reservation",
        idempotencyKey: `WITHDRAW-${idempotencyKey}`,
        balanceEffect: -1
      });

      if (!ledger) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          success: false,
          message: "This withdrawal has already been processed."
        });
      }

      await client.query(
        `UPDATE wallets
         SET balance = balance - $1,
             updated_at = NOW()
         WHERE id = $2`,
        [centsMoney(amountCents), wallet.id]
      );

      const result = await client.query(
        `INSERT INTO withdrawal_requests (
           user_id,
           wallet_id,
           request_reference,
           idempotency_key,
           amount,
           fee,
           net_amount,
           payment_method,
           account_name,
           account_number_encrypted,
           account_number_masked,
           status,
           wallet_transaction_id
         )
         VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           $8, $9, $10, $11, 'pending', $12
         )
         RETURNING
           id,
           request_reference,
           amount,
           fee,
           net_amount,
           payment_method,
           account_name,
           account_number_masked,
           status,
           requested_at`,
        [
          req.auth.id,
          wallet.id,
          reference,
          idempotencyKey,
          centsMoney(amountCents),
          centsMoney(feeCents),
          centsMoney(netCents),
          method,
          accountName,
          encryptedAccount,
          maskAccount(accountNumber),
          ledger.id
        ]
      );

      await client.query("COMMIT");

      // Notify Admin after successful withdrawal request.
      sendAdminPush("new_withdrawal", {
        reference: reference,
        message: `A new withdrawal request of ${centsMoney(amountCents)} has been submitted.`
      }).catch(error => {
        console.error("New withdrawal Admin push failed:", error.message);
      });

      return res.status(201).json({
        success: true,
        message: "Withdrawal request submitted successfully.",
        request: result.rows[0]
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});

      if (error.code === "23505") {
        return res.status(409).json({
          success: false,
          message: "Duplicate withdrawal request."
        });
      }

      next(error);
    } finally {
      client.release();
    }
  }
);

// =====================================================
// MEMBER WITHDRAWAL HISTORY
// GET /api/wallet/withdrawals
// =====================================================

router.get(
  "/withdrawals",
  authenticateToken,
  async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT
           id,
           request_reference,
           amount,
           fee,
           net_amount,
           payment_method,
           account_name,
           account_number_masked,
           status,
           admin_note,
           payment_reference,
           requested_at,
           approved_at,
           processing_at,
           paid_at,
           rejected_at
         FROM withdrawal_requests
         WHERE user_id = $1
         ORDER BY requested_at DESC
         LIMIT 100`,
        [req.auth.id]
      );

      return res.json({
        success: true,
        withdrawals: result.rows
      });
    } catch (error) {
      next(error);
    }
  }
);

// =====================================================
// ADMIN AUTHENTICATION
// =====================================================

router.use("/admin", authenticateToken, requireAdmin);

// =====================================================
// ADMIN DEPOSIT LIST
// GET /api/wallet/admin/deposits
// =====================================================

router.get("/admin/deposits", async (req, res, next) => {
  try {
    const status = String(req.query.status || "").trim();

    const values = [];
    let where = "";

    if (status) {
      if (!["pending", "approved", "rejected"].includes(status)) {
        return res.status(400).json({
          success: false,
          message: "Invalid deposit status."
        });
      }

      values.push(status);
      where = "WHERE d.status = $1";
    }

    const result = await pool.query(
      `SELECT
         d.*,
         u.full_name,
         u.email
       FROM wallet_deposit_requests d
       JOIN users u ON u.id = d.user_id
       ${where}
       ORDER BY d.created_at DESC
       LIMIT 200`,
      values
    );

    return res.json({
      success: true,
      deposits: result.rows
    });
  } catch (error) {
    next(error);
  }
});

// =====================================================
// ADMIN APPROVE DEPOSIT
// POST /api/wallet/admin/deposits/:id/approve
// =====================================================

router.post(
  "/admin/deposits/:id/approve",
  async (req, res, next) => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const requestResult = await client.query(
        `SELECT *
         FROM wallet_deposit_requests
         WHERE id = $1
         FOR UPDATE`,
        [req.params.id]
      );

      if (!requestResult.rowCount) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          success: false,
          message: "Deposit request not found."
        });
      }

      const request = requestResult.rows[0];

      if (request.status !== "pending") {
        await client.query("ROLLBACK");

        return res.status(409).json({
          success: false,
          message: "This deposit request has already been processed."
        });
      }

      const walletResult = await client.query(
        `SELECT id
         FROM wallets
         WHERE id = $1
         FOR UPDATE`,
        [request.wallet_id]
      );

      if (!walletResult.rowCount) {
        throw new Error("Wallet not found.");
      }

      const amountCents = moneyCents(request.amount);

      const ledger = await createLedgerTransaction(client, {
        walletId: request.wallet_id,
        type: "deposit",
        amountCents,
        reference: request.request_reference,
        description: "Admin-approved wallet deposit",
        idempotencyKey: `DEPOSIT-${request.id}`,
        balanceEffect: 1
      });

      if (!ledger) {
        throw new Error("Deposit ledger transaction already exists.");
      }

      await client.query(
        `UPDATE wallets
         SET balance = balance + $1,
             updated_at = NOW()
         WHERE id = $2`,
        [centsMoney(amountCents), request.wallet_id]
      );

      await client.query(
        `UPDATE wallet_deposit_requests
         SET status = 'approved',
             processed_by = $1,
             approved_at = NOW(),
             updated_at = NOW()
         WHERE id = $2`,
        [req.auth.id, request.id]
      );

      await client.query("COMMIT");

      return res.json({
        success: true,
        message: "Deposit approved and wallet credited."
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      next(error);
    } finally {
      client.release();
    }
  }
);

// =====================================================
// ADMIN REJECT DEPOSIT
// POST /api/wallet/admin/deposits/:id/reject
// =====================================================

router.post(
  "/admin/deposits/:id/reject",
  async (req, res, next) => {
    try {
      const note = String(
        req.body.admin_note || ""
      ).trim();

      const result = await pool.query(
        `UPDATE wallet_deposit_requests
         SET status = 'rejected',
             admin_note = $1,
             processed_by = $2,
             rejected_at = NOW(),
             updated_at = NOW()
         WHERE id = $3
           AND status = 'pending'
         RETURNING id`,
        [note.slice(0, 1000), req.auth.id, req.params.id]
      );

      if (!result.rowCount) {
        return res.status(409).json({
          success: false,
          message: "Request not found or already processed."
        });
      }

      return res.json({
        success: true,
        message: "Deposit request rejected."
      });
    } catch (error) {
      next(error);
    }
  }
);

// =====================================================
// ADMIN WITHDRAWAL LIST
// GET /api/wallet/admin/withdrawals
// =====================================================

router.get("/admin/withdrawals", async (req, res, next) => {
  try {
    const status = String(req.query.status || "").trim();

    const values = [];
    let where = "";

    if (status) {
      if (
        !["pending", "approved", "processing", "paid", "rejected"].includes(status)
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid withdrawal status."
        });
      }

      values.push(status);
      where = "WHERE w.status = $1";
    }

    const result = await pool.query(
      `SELECT
         w.id,
         w.user_id,
         w.request_reference,
         w.amount,
         w.fee,
         w.net_amount,
         w.payment_method,
         w.account_name,
         w.account_number_masked,
         w.status,
         w.admin_note,
         w.payment_reference,
         w.requested_at,
         w.approved_at,
         w.processing_at,
         w.paid_at,
         w.rejected_at,
         u.full_name,
         u.email
       FROM withdrawal_requests w
       JOIN users u ON u.id = w.user_id
       ${where}
       ORDER BY w.requested_at DESC
       LIMIT 200`,
      values
    );

    return res.json({
      success: true,
      withdrawals: result.rows
    });
  } catch (error) {
    next(error);
  }
});

// =====================================================
// ADMIN APPROVE WITHDRAWAL
// POST /api/wallet/admin/withdrawals/:id/approve
// =====================================================

router.post(
  "/admin/withdrawals/:id/approve",
  async (req, res, next) => {
    try {
      const result = await pool.query(
        `UPDATE withdrawal_requests
         SET status = 'approved',
             processed_by = $1,
             approved_at = NOW(),
             updated_at = NOW()
         WHERE id = $2
           AND status = 'pending'
         RETURNING id, request_reference, net_amount`,
        [req.auth.id, req.params.id]
      );

      if (!result.rowCount) {
        return res.status(409).json({
          success: false,
          message: "Request not found or already processed."
        });
      }

      return res.json({
        success: true,
        message: "Withdrawal approved.",
        request: result.rows[0]
      });
    } catch (error) {
      next(error);
    }
  }
);

// =====================================================
// ADMIN MARK WITHDRAWAL PROCESSING
// POST /api/wallet/admin/withdrawals/:id/processing
// =====================================================

router.post(
  "/admin/withdrawals/:id/processing",
  async (req, res, next) => {
    try {
      const result = await pool.query(
        `UPDATE withdrawal_requests
         SET status = 'processing',
             processed_by = $1,
             processing_at = NOW(),
             updated_at = NOW()
         WHERE id = $2
           AND status = 'approved'
         RETURNING id, request_reference`,
        [req.auth.id, req.params.id]
      );

      if (!result.rowCount) {
        return res.status(409).json({
          success: false,
          message: "Only approved requests can be processed."
        });
      }

      return res.json({
        success: true,
        message: "Withdrawal marked as processing."
      });
    } catch (error) {
      next(error);
    }
  }
);

// =====================================================
// ADMIN GET FULL PAYMENT DETAILS
// GET /api/wallet/admin/withdrawals/:id/payment-details
//
// IMPORTANT:
// Full account number is available to Admin only.
// Allowed statuses: pending, approved, processing.
// =====================================================

router.get(
  "/admin/withdrawals/:id/payment-details",
  async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT
           id,
           user_id,
           request_reference,
           payment_method,
           account_name,
           account_number_encrypted,
           account_number_masked,
           status
         FROM withdrawal_requests
         WHERE id = $1`,
        [req.params.id]
      );

      if (!result.rowCount) {
        return res.status(404).json({
          success: false,
          message: "Withdrawal request not found."
        });
      }

      const request = result.rows[0];

      // FIX: Pending status is now allowed.
      if (
        !["pending", "approved", "processing"].includes(
          String(request.status).toLowerCase()
        )
      ) {
        return res.status(409).json({
          success: false,
          message: "Payment details are not available for this withdrawal status."
        });
      }

      if (!request.account_number_encrypted) {
        return res.status(404).json({
          success: false,
          message: "Encrypted payment account was not found."
        });
      }

      const accountNumber = decryptAccountNumber(
        request.account_number_encrypted
      );

      return res.json({
        success: true,
        payment_details: {
          request_reference: request.request_reference,
          payment_method: request.payment_method,
          account_name: request.account_name,
          account_number: accountNumber
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

// =====================================================
// ADMIN MARK WITHDRAWAL AS PAID
// POST /api/wallet/admin/withdrawals/:id/paid
//
// Records manual payment.
// Does NOT send money automatically.
// =====================================================

router.post(
  "/admin/withdrawals/:id/paid",
  async (req, res, next) => {
    try {
      const paymentReference = String(
        req.body.payment_reference || ""
      ).trim();

      if (
        paymentReference.length < 3 ||
        paymentReference.length > 150
      ) {
        return res.status(400).json({
          success: false,
          message: "A valid payment reference is required."
        });
      }

      const result = await pool.query(
        `UPDATE withdrawal_requests
         SET status = 'paid',
             payment_reference = $1,
             processed_by = $2,
             paid_at = NOW(),
             updated_at = NOW()
         WHERE id = $3
           AND status IN ('approved', 'processing')
         RETURNING id, request_reference`,
        [paymentReference, req.auth.id, req.params.id]
      );

      if (!result.rowCount) {
        return res.status(409).json({
          success: false,
          message: "Request not found or not ready for payment."
        });
      }

      return res.json({
        success: true,
        message: "Withdrawal payment recorded as paid."
      });
    } catch (error) {
      next(error);
    }
  }
);

// =====================================================
// ADMIN REJECT WITHDRAWAL
// Reserved balance is returned to member.
// POST /api/wallet/admin/withdrawals/:id/reject
// =====================================================

router.post(
  "/admin/withdrawals/:id/reject",
  async (req, res, next) => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const requestResult = await client.query(
        `SELECT *
         FROM withdrawal_requests
         WHERE id = $1
         FOR UPDATE`,
        [req.params.id]
      );

      if (!requestResult.rowCount) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          success: false,
          message: "Withdrawal request not found."
        });
      }

      const request = requestResult.rows[0];

      if (!["pending", "approved"].includes(request.status)) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          success: false,
          message: "Only pending or approved requests can be rejected."
        });
      }

      const walletLock = await client.query(
        `SELECT id
         FROM wallets
         WHERE id = $1
         FOR UPDATE`,
        [request.wallet_id]
      );

      if (!walletLock.rowCount) {
        throw new Error("Wallet not found.");
      }

      const amountCents = moneyCents(request.amount);

      const ledger = await createLedgerTransaction(client, {
        walletId: request.wallet_id,
        type: "refund",
        amountCents,
        reference: `REJECT-${request.request_reference}`,
        description: "Rejected withdrawal amount returned to wallet",
        idempotencyKey: `WITHDRAW-REJECT-${request.id}`,
        balanceEffect: 1
      });

      if (!ledger) {
        throw new Error("Withdrawal refund transaction already exists.");
      }

      await client.query(
        `UPDATE wallets
         SET balance = balance + $1,
             updated_at = NOW()
         WHERE id = $2`,
        [centsMoney(amountCents), request.wallet_id]
      );

      await client.query(
        `UPDATE withdrawal_requests
         SET status = 'rejected',
             admin_note = $1,
             processed_by = $2,
             rejected_at = NOW(),
             updated_at = NOW()
         WHERE id = $3`,
        [
          String(req.body.admin_note || "").trim().slice(0, 1000),
          req.auth.id,
          request.id
        ]
      );

      await client.query("COMMIT");

      return res.json({
        success: true,
        message: "Withdrawal rejected. Reserved wallet balance returned."
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      next(error);
    } finally {
      client.release();
    }
  }
);

// =====================================================
// WALLET RECONCILIATION
// GET /api/wallet/reconciliation
// Admin only.
// This endpoint reports mismatches.
// It never changes wallet balances automatically.
// =====================================================

router.get(
  "/reconciliation",
  authenticateToken,
  requireAdmin,
  async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT
           w.id AS wallet_id,
           w.user_id,
           w.balance AS recorded_balance,
           COALESCE(
             SUM(
               CASE
                 WHEN wt.status = 'completed'
                 THEN wt.amount * wt.balance_effect
                 ELSE 0
               END
             ),
             0
           ) AS ledger_balance
         FROM wallets w
         LEFT JOIN wallet_transactions wt
           ON wt.wallet_id = w.id
         GROUP BY w.id
         ORDER BY w.id`
      );

      const reports = [];

      for (const row of result.rows) {
        const recordedCents = moneyCents(
          row.recorded_balance
        );

        const ledgerCents = Math.round(
          Number(row.ledger_balance) * 100
        );

        const differenceCents =
          recordedCents - ledgerCents;

        const status =
          differenceCents === 0 ? "matched" : "mismatch";

        await pool.query(
          `INSERT INTO wallet_reconciliation_logs (
             wallet_id,
             recorded_balance,
             ledger_balance,
             difference,
             status,
             checked_by
           )
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            row.wallet_id,
            row.recorded_balance,
            centsMoney(ledgerCents),
            centsMoney(differenceCents),
            status,
            req.auth.id
          ]
        );

        reports.push({
          wallet_id: row.wallet_id,
          user_id: row.user_id,
          recorded_balance: row.recorded_balance,
          ledger_balance: centsMoney(ledgerCents),
          difference: centsMoney(differenceCents),
          status
        });
      }

      return res.json({
        success: true,
        total_wallets: reports.length,
        matched: reports.filter(
          x => x.status === "matched"
        ).length,
        mismatched: reports.filter(
          x => x.status === "mismatch"
        ).length,
        reports
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
