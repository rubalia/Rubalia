ফাইল: "routes/refund.routes.js"

"use strict";

const express = require("express");
const pool = require("../config/database");
const { authenticateToken } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/admin");
const {
  reverseOrderCommission
} = require("../services/commission.service");

const router = express.Router();

router.use(authenticateToken);

function validId(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

function cleanNote(value) {
  const note = String(value || "").trim();

  if (note.length > 2000) {
    throw Object.assign(
      new Error("Admin note cannot exceed 2000 characters."),
      { statusCode: 400 }
    );
  }

  return note;
}

function sendError(res, error, next) {
  if (error.statusCode) {
    return res.status(error.statusCode).json({
      success: false,
      message: error.message
    });
  }

  return next(error);
}

// =====================================================
// ADMIN PENDING REFUNDS
// GET /api/refunds/admin/pending
// =====================================================

router.get("/admin/pending", requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT
        o.id,
        o.order_number,
        o.user_id,
        u.full_name AS customer_name,
        u.email AS customer_email,
        o.total_amount,
        o.payment_method,
        o.payment_status,
        o.status,
        o.refund_status,
        o.refund_requested_at,
        o.refund_admin_note,
        o.created_at,
        o.updated_at
      FROM orders o
      JOIN users u ON u.id = o.user_id
      WHERE o.status = 'cancelled'
        AND o.refund_status IN ('not_requested', 'pending')
      ORDER BY o.updated_at DESC
      LIMIT 300
    `);

    return res.json({
      success: true,
      refunds: result.rows
    });
  } catch (error) {
    next(error);
  }
});

// =====================================================
// RECORD REFUND REQUEST
// POST /api/refunds/:orderId/request
// Does not transfer money.
// =====================================================

router.post("/:orderId/request", requireAdmin, async (req, res, next) => {
  const client = await pool.connect();
  let started = false;

  try {
    const orderId = Number(req.params.orderId);
    const note = cleanNote(req.body?.note);

    if (!validId(orderId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid order ID."
      });
    }

    await client.query("BEGIN");
    started = true;

    const result = await client.query(`
      SELECT id, status, payment_status, refund_status
      FROM orders
      WHERE id = $1
      FOR UPDATE
    `, [orderId]);

    if (!result.rows.length) {
      throw Object.assign(new Error("Order not found."), {
        statusCode: 404
      });
    }

    const order = result.rows[0];

    if (order.status !== "cancelled") {
      throw Object.assign(
        new Error("Only cancelled orders can enter the refund workflow."),
        { statusCode: 409 }
      );
    }

    if (
      order.payment_status === "refunded" ||
      order.refund_status === "completed"
    ) {
      throw Object.assign(
        new Error("This order has already been refunded."),
        { statusCode: 409 }
      );
    }

    if (order.refund_status === "rejected") {
      throw Object.assign(
        new Error("This refund request has already been rejected."),
        { statusCode: 409 }
      );
    }

    await client.query(`
      UPDATE orders
      SET
        refund_status = 'pending',
        refund_requested_at = COALESCE(refund_requested_at, NOW()),
        refund_admin_note = CASE
          WHEN $1 = '' THEN refund_admin_note
          ELSE $1
        END,
        updated_at = NOW()
      WHERE id = $2
    `, [note, orderId]);

    await client.query("COMMIT");
    started = false;

    return res.json({
      success: true,
      message: "Refund request recorded. No money has been transferred.",
      orderId
    });
  } catch (error) {
    if (started) await client.query("ROLLBACK").catch(() => {});
    return sendError(res, error, next);
  } finally {
    client.release();
  }
});

// =====================================================
// CONFIRM REFUND
// POST /api/refunds/:orderId/confirm
//
// Wallet payment only.
// Requires refund_status = pending.
// Refund + commission reversal are atomic.
// =====================================================

router.post("/:orderId/confirm", requireAdmin, async (req, res, next) => {
  const client = await pool.connect();
  let started = false;

  try {
    const orderId = Number(req.params.orderId);
    const note = cleanNote(req.body?.note);

    if (!validId(orderId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid order ID."
      });
    }

    await client.query("BEGIN");
    started = true;

    const result = await client.query(`
      SELECT
        id,
        user_id,
        order_number,
        total_amount,
        status,
        payment_method,
        payment_status,
        refund_status
      FROM orders
      WHERE id = $1
      FOR UPDATE
    `, [orderId]);

    if (!result.rows.length) {
      throw Object.assign(new Error("Order not found."), {
        statusCode: 404
      });
    }

    const order = result.rows[0];

    if (order.status !== "cancelled") {
      throw Object.assign(
        new Error("Only cancelled orders can be refunded."),
        { statusCode: 409 }
      );
    }

    if (
      order.payment_status === "refunded" ||
      order.refund_status === "completed"
    ) {
      throw Object.assign(
        new Error("This order has already been refunded."),
        { statusCode: 409 }
      );
    }

    if (order.refund_status !== "pending") {
      throw Object.assign(
        new Error("Record the refund request before confirming it."),
        { statusCode: 409 }
      );
    }

    if (order.payment_method !== "wallet") {
      throw Object.assign(
        new Error(
          "This route only supports Wallet-paid orders. Verify external payment refunds separately."
        ),
        { statusCode: 409 }
      );
    }

    if (order.payment_status !== "paid") {
      throw Object.assign(
        new Error("Only successfully paid orders can be refunded."),
        { statusCode: 409 }
      );
    }

    const refundAmount = Number(order.total_amount);

    if (!Number.isFinite(refundAmount) || refundAmount <= 0) {
      throw Object.assign(new Error("Invalid refund amount."), {
        statusCode: 409
      });
    }

    await client.query(`
      INSERT INTO wallets (user_id)
      VALUES ($1)
      ON CONFLICT (user_id) DO NOTHING
    `, [order.user_id]);

    const walletResult = await client.query(`
      SELECT id, balance
      FROM wallets
      WHERE user_id = $1
      FOR UPDATE
    `, [order.user_id]);

    if (!walletResult.rows.length) {
      throw new Error("Customer wallet could not be accessed.");
    }

    const wallet = walletResult.rows[0];
    const reference = `REFUND-ORDER-${order.id}`;

    const duplicate = await client.query(`
      SELECT id
      FROM wallet_transactions
      WHERE reference = $1
      LIMIT 1
    `, [reference]);

    if (duplicate.rows.length) {
      throw Object.assign(
        new Error("A refund transaction already exists for this order."),
        { statusCode: 409 }
      );
    }

    await client.query(`
      UPDATE wallets
      SET balance = balance + $1,
          updated_at = NOW()
      WHERE id = $2
    `, [refundAmount.toFixed(2), wallet.id]);

    await client.query(`
      INSERT INTO wallet_transactions (
        wallet_id,
        transaction_type,
        amount,
        reference,
        description,
        status
      )
      VALUES ($1, 'refund', $2, $3, $4, 'completed')
    `, [
      wallet.id,
      refundAmount.toFixed(2),
      reference,
      `Refund for order ${order.order_number}`
    ]);

    // Reverse commissions only after the refund is confirmed.
    const commissionResult = await reverseOrderCommission(
      client,
      order.id
    );

    await client.query(`
      UPDATE orders
      SET
        payment_status = 'refunded',
        refund_status = 'completed',
        refund_confirmed_at = NOW(),
        refund_confirmed_by = $1,
        refund_admin_note = CASE
          WHEN $2 = '' THEN refund_admin_note
          ELSE $2
        END,
        updated_at = NOW()
      WHERE id = $3
    `, [req.auth.id, note, order.id]);

    const updatedWallet = await client.query(`
      SELECT balance
      FROM wallets
      WHERE id = $1
    `, [wallet.id]);

    await client.query("COMMIT");
    started = false;

    return res.json({
      success: true,
      message: "Refund completed. Wallet credited and commission reversal processed.",
      refund: {
        orderId: Number(order.id),
        orderNumber: order.order_number,
        amount: refundAmount.toFixed(2),
        currency: "BDT",
        status: "completed",
        paymentStatus: "refunded",
        walletBalance: updatedWallet.rows[0].balance,
        commission: commissionResult
      }
    });
  } catch (error) {
    if (started) await client.query("ROLLBACK").catch(() => {});
    return sendError(res, error, next);
  } finally {
    client.release();
  }
});

// =====================================================
// REJECT REFUND
// POST /api/refunds/:orderId/reject
//
// Delivered order: restore Delivered.
// Undelivered order: keep Cancelled.
// No money transfer or commission reversal.
// =====================================================

router.post("/:orderId/reject", requireAdmin, async (req, res, next) => {
  const client = await pool.connect();
  let started = false;

  try {
    const orderId = Number(req.params.orderId);
    const note = cleanNote(req.body?.note);

    if (!validId(orderId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid order ID."
      });
    }

    if (!note) {
      return res.status(400).json({
        success: false,
        message: "A reason is required when rejecting a refund."
      });
    }

    await client.query("BEGIN");
    started = true;

    const result = await client.query(`
      SELECT
        id,
        order_number,
        status,
        payment_status,
        refund_status,
        delivered_at
      FROM orders
      WHERE id = $1
      FOR UPDATE
    `, [orderId]);

    if (!result.rows.length) {
      throw Object.assign(new Error("Order not found."), {
        statusCode: 404
      });
    }

    const order = result.rows[0];

    if (order.status !== "cancelled") {
      throw Object.assign(
        new Error("Only cancelled orders can have a refund request rejected."),
        { statusCode: 409 }
      );
    }

    if (order.refund_status !== "pending") {
      throw Object.assign(
        new Error("Only pending refund requests can be rejected."),
        { statusCode: 409 }
      );
    }

    if (order.payment_status === "refunded") {
      throw Object.assign(
        new Error("This order has already been refunded."),
        { statusCode: 409 }
      );
    }

    const nextStatus = order.delivered_at ? "delivered" : "cancelled";

    await client.query(`
      UPDATE orders
      SET
        status = $1,
        refund_status = 'rejected',
        refund_admin_note = $2,
        updated_at = NOW()
      WHERE id = $3
    `, [nextStatus, note, orderId]);

    await client.query("COMMIT");
    started = false;

    return res.json({
      success: true,
      message: order.delivered_at
        ? "Refund rejected. Delivered order restored; original commission maturity date remains unchanged."
        : "Refund rejected. Undelivered order remains cancelled. No money or commission was transferred.",
      order: {
        id: Number(order.id),
        orderNumber: order.order_number,
        status: nextStatus,
        refundStatus: "rejected"
      }
    });
  } catch (error) {
    if (started) await client.query("ROLLBACK").catch(() => {});
    return sendError(res, error, next);
  } finally {
    client.release();
  }
});

// =====================================================
// REFUND HISTORY
// GET /api/refunds/admin/history
// =====================================================

router.get("/admin/history", requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT
        o.id,
        o.order_number,
        o.user_id,
        u.full_name AS customer_name,
        u.email AS customer_email,
        o.total_amount,
        o.payment_method,
        o.payment_status,
        o.status,
        o.refund_status,
        o.refund_requested_at,
        o.refund_confirmed_at,
        o.refund_admin_note,
        o.updated_at
      FROM orders o
      JOIN users u ON u.id = o.user_id
      WHERE o.refund_status IN ('completed', 'rejected')
      ORDER BY o.updated_at DESC
      LIMIT 300
    `);

    return res.json({
      success: true,
      refunds: result.rows
    });
  } catch (error) {
    next(error);
  }
});

// =====================================================
// REFUND DETAILS
// GET /api/refunds/:orderId
// =====================================================

router.get("/:orderId", requireAdmin, async (req, res, next) => {
  try {
    const orderId = Number(req.params.orderId);

    if (!validId(orderId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid order ID."
      });
    }

    const result = await pool.query(`
      SELECT
        o.id,
        o.order_number,
        o.user_id,
        u.full_name AS customer_name,
        u.email AS customer_email,
        o.total_amount,
        o.payment_method,
        o.payment_status,
        o.status,
        o.refund_status,
        o.refund_requested_at,
        o.refund_confirmed_at,
        o.refund_confirmed_by,
        o.refund_admin_note
      FROM orders o
      JOIN users u ON u.id = o.user_id
      WHERE o.id = $1
    `, [orderId]);

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Order not found."
      });
    }

    return res.json({
      success: true,
      refund: result.rows[0]
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
