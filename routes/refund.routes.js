
"use strict";

// =====================================================
// RUBALIA NETWORK
// ADMIN CONTROLLED REFUND ROUTES
//
// Admin cancellation never refunds automatically.
// Admin must communicate with customer and explicitly
// confirm the refund before money is returned.
// =====================================================

const express = require("express");

const pool = require("../config/database");
const { authenticateToken } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/admin");

const {
  reverseOrderCommission
} = require("../services/commission.service");

const router = express.Router();

router.use(authenticateToken);

// =====================================================
// HELPERS
// =====================================================

function validId(value) {
  return (
    Number.isSafeInteger(Number(value)) &&
    Number(value) > 0
  );
}

function cleanNote(value) {
  const note = String(value || "").trim();

  if (note.length > 2000) {
    throw new Error("Admin note cannot exceed 2000 characters.");
  }

  return note;
}

// =====================================================
// GET /api/refunds/admin/pending
// Admin: cancelled orders awaiting refund decision.
// =====================================================

router.get(
  "/admin/pending",
  requireAdmin,
  async (req, res, next) => {
    try {
      const result = await pool.query(
        `
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
        `
      );

      return res.json({
        success: true,
        refunds: result.rows
      });

    } catch (error) {
      next(error);
    }
  }
);

// =====================================================
// POST /api/refunds/:orderId/request
// Admin records that refund discussion with customer
// has started. This does NOT transfer any money.
// =====================================================

router.post(
  "/:orderId/request",
  requireAdmin,
  async (req, res, next) => {
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

      const result = await client.query(
        `
        SELECT
          id,
          order_number,
          status,
          payment_method,
          payment_status,
          refund_status
        FROM orders
        WHERE id = $1
        FOR UPDATE
        `,
        [orderId]
      );

      if (!result.rows.length) {
        throw Object.assign(
          new Error("Order not found."),
          { statusCode: 404 }
        );
      }

      const order = result.rows[0];

      if (order.status !== "cancelled") {
        throw Object.assign(
          new Error(
            "Only cancelled orders can enter this refund workflow."
          ),
          { statusCode: 409 }
        );
      }

      if (order.payment_status === "refunded") {
        throw Object.assign(
          new Error("This order has already been refunded."),
          { statusCode: 409 }
        );
      }

      if (order.refund_status === "completed") {
        throw Object.assign(
          new Error("Refund has already been completed."),
          { statusCode: 409 }
        );
      }

      await client.query(
        `
        UPDATE orders
        SET
          refund_status = 'pending',
          refund_requested_at = COALESCE(
            refund_requested_at,
            NOW()
          ),
          refund_admin_note = CASE
            WHEN $1 = '' THEN refund_admin_note
            ELSE $1
          END,
          updated_at = NOW()
        WHERE id = $2
        `,
        [note, orderId]
      );

      await client.query("COMMIT");
      started = false;

      return res.json({
        success: true,
        message:
          "Refund discussion recorded. No money has been transferred.",
        orderId
      });

    } catch (error) {
      if (started) {
        await client.query("ROLLBACK").catch(() => {});
      }

      if (error.statusCode) {
        return res.status(error.statusCode).json({
          success: false,
          message: error.message
        });
      }

      next(error);

    } finally {
      client.release();
    }
  }
);

// =====================================================
// POST /api/refunds/:orderId/confirm
//
// Admin confirms that the customer has been contacted
// and a refund has been agreed.
//
// This endpoint:
// 1. Locks the order.
// 2. Checks that it is cancelled.
// 3. Checks that it has not already been refunded.
// 4. Credits the customer's wallet.
// 5. Creates one refund wallet transaction.
// 6. Reverses the order's commission.
// 7. Marks payment as refunded.
//
// All database changes happen in ONE transaction.
// =====================================================

router.post(
  "/:orderId/confirm",
  requireAdmin,
  async (req, res, next) => {
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

      const orderResult = await client.query(
        `
        SELECT
          id,
          user_id,
          order_number,
          total_amount,
          status,
          payment_method,
          payment_status,
          refund_status,
          commission_status
        FROM orders
        WHERE id = $1
        FOR UPDATE
        `,
        [orderId]
      );

      if (!orderResult.rows.length) {
        throw Object.assign(
          new Error("Order not found."),
          { statusCode: 404 }
        );
      }

      const order = orderResult.rows[0];

      // Only Admin-cancelled orders can be refunded
      // through this specific workflow.
      if (order.status !== "cancelled") {
        throw Object.assign(
          new Error(
            "Cancel the order first before confirming its refund."
          ),
          { statusCode: 409 }
        );
      }

      // Idempotency protection.
      if (
        order.payment_status === "refunded" ||
        order.refund_status === "completed"
      ) {
        throw Object.assign(
          new Error("This order has already been refunded."),
          { statusCode: 409 }
        );
      }

      // This route only refunds wallet-paid orders.
      // External gateway refunds need separate verification.
      if (order.payment_method !== "wallet") {
        throw Object.assign(
          new Error(
            "This order was not paid using Wallet. Verify the original payment method and use its verified refund process."
          ),
          { statusCode: 409 }
        );
      }

      if (order.payment_status !== "paid") {
        throw Object.assign(
          new Error(
            "Only successfully paid orders can be refunded."
          ),
          { statusCode: 409 }
        );
      }

      const refundAmount = Number(order.total_amount);

      if (
        !Number.isFinite(refundAmount) ||
        refundAmount <= 0
      ) {
        throw Object.assign(
          new Error("Invalid refund amount."),
          { statusCode: 409 }
        );
      }

      // Ensure customer wallet exists.
      await client.query(
        `
        INSERT INTO wallets (user_id)
        VALUES ($1)
        ON CONFLICT (user_id)
        DO NOTHING
        `,
        [order.user_id]
      );

      const walletResult = await client.query(
        `
        SELECT id, balance
        FROM wallets
        WHERE user_id = $1
        FOR UPDATE
        `,
        [order.user_id]
      );

      if (!walletResult.rows.length) {
        throw new Error("Customer wallet could not be accessed.");
      }

      const wallet = walletResult.rows[0];

      // Unique reference prevents duplicate refund transactions.
      const refundReference = `REFUND-ORDER-${order.id}`;

      const existingRefund = await client.query(
        `
        SELECT id
        FROM wallet_transactions
        WHERE reference = $1
        LIMIT 1
        `,
        [refundReference]
      );

      if (existingRefund.rows.length) {
        throw Object.assign(
          new Error(
            "A refund transaction already exists for this order."
          ),
          { statusCode: 409 }
        );
      }

      // Credit customer wallet.
      await client.query(
        `
        UPDATE wallets
        SET
          balance = balance + $1,
          updated_at = NOW()
        WHERE id = $2
        `,
        [refundAmount.toFixed(2), wallet.id]
      );

      // Record refund transaction.
      await client.query(
        `
        INSERT INTO wallet_transactions (
          wallet_id,
          transaction_type,
          amount,
          reference,
          description,
          status
        )
        VALUES (
          $1,
          'refund',
          $2,
          $3,
          $4,
          'completed'
        )
        `,
        [
          wallet.id,
          refundAmount.toFixed(2),
          refundReference,
          `Refund for order ${order.order_number}`
        ]
      );

      // Reverse commission only after refund is confirmed.
      // Pending commission is voided.
      // Already released commission is recovered/debited.
      const commissionResult = await reverseOrderCommission(
        client,
        order.id
      );

      // Mark order payment as refunded.
      await client.query(
        `
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
        `,
        [
          req.auth.id,
          note,
          order.id
        ]
      );

      const updatedWallet = await client.query(
        `
        SELECT balance
        FROM wallets
        WHERE id = $1
        `,
        [wallet.id]
      );

      await client.query("COMMIT");
      started = false;

      return res.json({
        success: true,
        message:
          "Refund confirmed. Customer wallet has been credited and commission reversal has been processed.",
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
      if (started) {
        await client.query("ROLLBACK").catch(() => {});
      }

      if (error.statusCode) {
        return res.status(error.statusCode).json({
          success: false,
          message: error.message
        });
      }

      next(error);

    } finally {
      client.release();
    }
  }
);

// =====================================================
// GET /api/refunds/:orderId
// Admin can view refund status and notes.
// =====================================================

router.get(
  "/:orderId",
  requireAdmin,
  async (req, res, next) => {
    try {
      const orderId = Number(req.params.orderId);

      if (!validId(orderId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid order ID."
        });
      }

      const result = await pool.query(
        `
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
        `,
        [orderId]
      );

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
  }
);

module.exports = router;
