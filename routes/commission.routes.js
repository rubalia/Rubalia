
"use strict";

// =====================================================
// RUBALIA NETWORK
// COMMISSION API ROUTES
// 10 LEVEL UNILEVEL SYSTEM
// DYNAMIC ELIGIBLE COMMISSION
// =====================================================

const express = require("express");
const pool = require("../config/database");

const { authenticateToken } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/admin");

const {
  DEFAULT_RATES,
  validateRates,
  prepareOrderCommission,
  releaseOrderCommission
} = require("../services/commission.service");

const router = express.Router();

router.use(authenticateToken);


// =====================================================
// HELPERS
// =====================================================

function validId(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

function validCost(value) {
  const number = Number(value);

  return (
    Number.isFinite(number) &&
    number >= 0 &&
    number <= 9999999999
  );
}

function validRefundPeriod(value) {
  return (
    Number.isInteger(Number(value)) &&
    Number(value) >= 0 &&
    Number(value) <= 365
  );
}


// =====================================================
// 1. MEMBER INCOME SUMMARY
// GET /api/commission/me
// =====================================================

router.get("/me", async (req, res, next) => {
  try {
    const memberId = req.auth.id;

    const summaryResult = await pool.query(
      `
      SELECT
        COALESCE(
          SUM(amount) FILTER (
            WHERE status = 'credited'
          ), 0
        ) AS total_earned,

        COALESCE(
          SUM(amount) FILTER (
            WHERE status = 'pending'
          ), 0
        ) AS total_pending,

        COALESCE(
          SUM(amount) FILTER (
            WHERE status = 'reversed'
          ), 0
        ) AS total_reversed,

        COUNT(*) FILTER (
          WHERE status = 'credited'
        ) AS total_transactions,

        COUNT(*) FILTER (
          WHERE status = 'pending'
        ) AS pending_transactions

      FROM commission_ledger
      WHERE beneficiary_id = $1
      `,
      [memberId]
    );

    const debtResult = await pool.query(
      `
      SELECT
        COALESCE(
          SUM(original_amount - recovered_amount),
          0
        ) AS outstanding_debt

      FROM commission_reversal_debts

      WHERE user_id = $1
        AND status IN ('open', 'partially_recovered')
      `,
      [memberId]
    );

    const summary = summaryResult.rows[0];

    return res.json({
      success: true,

      income: {
        totalEarned: Number(summary.total_earned),
        totalPending: Number(summary.total_pending),
        totalReversed: Number(summary.total_reversed),

        totalTransactions: Number(
          summary.total_transactions
        ),

        pendingTransactions: Number(
          summary.pending_transactions
        ),

        outstandingDebt: Number(
          debtResult.rows[0].outstanding_debt
        )
      }
    });

  } catch (error) {
    next(error);
  }
});


// =====================================================
// 2. MEMBER COMMISSION TRANSACTIONS
// GET /api/commission/transactions
// =====================================================

router.get("/transactions", async (req, res, next) => {
  try {
    const result = await pool.query(
      `
      SELECT
        cl.id,
        cl.order_id,
        o.order_number,
        cl.level,
        cl.rate_percent,
        cl.profit_base,
        cl.amount,
        cl.status,
        cl.created_at,
        cl.released_at,
        cl.reversed_at

      FROM commission_ledger cl

      INNER JOIN orders o
        ON o.id = cl.order_id

      WHERE cl.beneficiary_id = $1

      ORDER BY cl.created_at DESC

      LIMIT 200
      `,
      [req.auth.id]
    );

    return res.json({
      success: true,
      transactions: result.rows
    });

  } catch (error) {
    next(error);
  }
});


// =====================================================
// 3. ADMIN COMMISSION SETTINGS
// GET /api/commission/admin/settings
// =====================================================

router.get(
  "/admin/settings",
  requireAdmin,
  async (req, res, next) => {
    try {
      const result = await pool.query(
        `
        SELECT
          id,
          enabled,
          legal_approval_confirmed,
          gateway_fee_percent,
          level_rates,
          refund_period_days,
          updated_by,
          updated_at

        FROM commission_settings

        WHERE id = 1
        `
      );

      if (!result.rows.length) {
        return res.status(404).json({
          success: false,
          message: "Commission settings not found."
        });
      }

      return res.json({
        success: true,
        settings: result.rows[0]
      });

    } catch (error) {
      next(error);
    }
  }
);


// =====================================================
// 4. UPDATE COMMISSION SETTINGS
// PUT /api/commission/admin/settings
// =====================================================

router.put(
  "/admin/settings",
  requireAdmin,
  async (req, res, next) => {
    try {
      const enabled = req.body.enabled === true;

      const legalApprovalConfirmed =
        req.body.legalApprovalConfirmed === true;

      const gatewayFeePercent =
        Number(req.body.gatewayFeePercent ?? 0);

      const refundPeriodDays =
        Number(req.body.refundPeriodDays ?? 7);

      let rates;

      try {
        rates = validateRates(
          req.body.levelRates ?? DEFAULT_RATES
        );
      } catch (error) {
        return res.status(400).json({
          success: false,
          message: error.message
        });
      }

      if (
        !Number.isFinite(gatewayFeePercent) ||
        gatewayFeePercent < 0 ||
        gatewayFeePercent > 100
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid gateway fee percentage."
        });
      }

      if (!validRefundPeriod(refundPeriodDays)) {
        return res.status(400).json({
          success: false,
          message: "Refund period must be between 0 and 365 days."
        });
      }

      if (enabled && !legalApprovalConfirmed) {
        return res.status(409).json({
          success: false,
          message:
            "Required legal approval must be confirmed before enabling commissions."
        });
      }

      const result = await pool.query(
        `
        UPDATE commission_settings

        SET
          enabled = $1,
          legal_approval_confirmed = $2,
          gateway_fee_percent = $3,
          level_rates = $4::jsonb,
          refund_period_days = $5,
          updated_by = $6,
          updated_at = NOW()

        WHERE id = 1

        RETURNING *
        `,
        [
          enabled,
          legalApprovalConfirmed,
          gatewayFeePercent,
          JSON.stringify(rates),
          refundPeriodDays,
          req.auth.id
        ]
      );

      if (!result.rows.length) {
        return res.status(404).json({
          success: false,
          message: "Commission settings not found."
        });
      }

      return res.json({
        success: true,
        message: "Commission settings updated successfully.",
        settings: result.rows[0]
      });

    } catch (error) {
      next(error);
    }
  }
);


// =====================================================
// 5. UPDATE PRODUCT COSTS
// PUT /api/commission/admin/costs/product/:id
// =====================================================

router.put(
  "/admin/costs/product/:id",
  requireAdmin,
  async (req, res, next) => {
    try {
      const productId = Number(req.params.id);

      if (!validId(productId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid product ID."
        });
      }

      const costPrice = Number(req.body.costPrice ?? 0);
      const deliveryCost = Number(req.body.deliveryCost ?? 0);
      const packagingCost = Number(req.body.packagingCost ?? 0);
      const otherCost = Number(req.body.otherCost ?? 0);

      const costs = [
        costPrice,
        deliveryCost,
        packagingCost,
        otherCost
      ];

      if (costs.some(value => !validCost(value))) {
        return res.status(400).json({
          success: false,
          message: "Invalid product cost information."
        });
      }

      const result = await pool.query(
        `
        UPDATE products

        SET
          cost_price = $1,
          delivery_cost = $2,
          packaging_cost = $3,
          other_cost = $4,
          updated_at = NOW()

        WHERE id = $5

        RETURNING
          id,
          name,
          cost_price,
          delivery_cost,
          packaging_cost,
          other_cost
        `,
        [
          costPrice,
          deliveryCost,
          packagingCost,
          otherCost,
          productId
        ]
      );

      if (!result.rows.length) {
        return res.status(404).json({
          success: false,
          message: "Product not found."
        });
      }

      return res.json({
        success: true,
        message: "Product costs updated successfully.",
        product: result.rows[0]
      });

    } catch (error) {
      next(error);
    }
  }
);


// =====================================================
// 6. UPDATE PACKAGE COSTS
// PUT /api/commission/admin/costs/package/:id
// =====================================================

router.put(
  "/admin/costs/package/:id",
  requireAdmin,
  async (req, res, next) => {
    try {
      const packageId = Number(req.params.id);

      if (!validId(packageId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid package ID."
        });
      }

      const deliveryCost = Number(req.body.deliveryCost ?? 0);
      const packagingCost = Number(req.body.packagingCost ?? 0);
      const otherCost = Number(req.body.otherCost ?? 0);

      const costs = [
        deliveryCost,
        packagingCost,
        otherCost
      ];

      if (costs.some(value => !validCost(value))) {
        return res.status(400).json({
          success: false,
          message: "Invalid package cost information."
        });
      }

      const result = await pool.query(
        `
        UPDATE packages

        SET
          delivery_cost = $1,
          packaging_cost = $2,
          other_cost = $3,
          updated_at = NOW()

        WHERE id = $4

        RETURNING
          id,
          name,
          delivery_cost,
          packaging_cost,
          other_cost
        `,
        [
          deliveryCost,
          packagingCost,
          otherCost,
          packageId
        ]
      );

      if (!result.rows.length) {
        return res.status(404).json({
          success: false,
          message: "Package not found."
        });
      }

      return res.json({
        success: true,
        message: "Package costs updated successfully.",
        package: result.rows[0]
      });

    } catch (error) {
      next(error);
    }
  }
);


// =====================================================
// 7. ADMIN RELEASE ORDER COMMISSION
// POST /api/commission/admin/orders/:id/release
// =====================================================

router.post(
  "/admin/orders/:id/release",
  requireAdmin,
  async (req, res, next) => {
    const orderId = Number(req.params.id);

    if (!validId(orderId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid order ID."
      });
    }

    const client = await pool.connect();
    let transactionStarted = false;

    try {
      await client.query("BEGIN");
      transactionStarted = true;

      const commission = await releaseOrderCommission(
        client,
        orderId
      );

      await client.query("COMMIT");
      transactionStarted = false;

      return res.json({
        success: true,

        message: commission.duplicate
          ? "Commission was already released."
          : "Order commission released successfully.",

        commission
      });

    } catch (error) {
      if (transactionStarted) {
        await client.query("ROLLBACK").catch(() => {});
      }

      const conflictMessages = [
        "Commission engine is disabled.",
        "Required legal approval has not been confirmed.",
        "Only paid and delivered orders can release commission.",
        "Order does not have pending commission.",
        "Commission ledger is incomplete. Expected exactly 10 levels.",
        "Commission ledger contains a non-pending entry.",
        "Company profit ledger not found."
      ];

      if (conflictMessages.includes(error.message)) {
        return res.status(409).json({
          success: false,
          message: error.message
        });
      }

      if (error.message === "Order not found.") {
        return res.status(404).json({
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
// 8. ADMIN RETRY / PROCESS DELIVERED ORDER COMMISSION
// POST /api/commission/admin/orders/:id/retry
//
// Processes old delivered and paid orders whose commission
// status is not_eligible, or releases existing pending rows.
//
// Reversed and already released orders cannot be credited again.
// =====================================================

router.post(
  "/admin/orders/:id/retry",
  requireAdmin,
  async (req, res, next) => {
    const orderId = Number(req.params.id);

    if (!validId(orderId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid order ID."
      });
    }

    const client = await pool.connect();
    let transactionStarted = false;

    try {
      await client.query("BEGIN");
      transactionStarted = true;

      const orderResult = await client.query(
        `
        SELECT
          id,
          order_number,
          status,
          payment_status,
          commission_status
        FROM orders
        WHERE id = $1
        FOR UPDATE
        `,
        [orderId]
      );

      if (!orderResult.rows.length) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(404).json({
          success: false,
          message: "Order not found."
        });
      }

      const order = orderResult.rows[0];

      if (
        order.status !== "delivered" ||
        order.payment_status !== "paid"
      ) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(409).json({
          success: false,
          message: "Only paid and delivered orders can be processed."
        });
      }

      if (order.commission_status === "released") {
        await client.query("COMMIT");
        transactionStarted = false;

        return res.json({
          success: true,
          duplicate: true,
          message: "Commission has already been released."
        });
      }

      if (order.commission_status === "reversed") {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(409).json({
          success: false,
          message: "A reversed order cannot be processed again."
        });
      }

      let preparation = null;

      if (order.commission_status === "not_eligible") {
        preparation = await prepareOrderCommission(
          client,
          orderId
        );

        if (!preparation.success) {
          await client.query("ROLLBACK");
          transactionStarted = false;

          return res.status(409).json({
            success: false,
            message: preparation.message ||
              "Commission could not be prepared.",
            preparation
          });
        }

      } else if (order.commission_status !== "pending") {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(409).json({
          success: false,
          message: "Order is not eligible for commission retry."
        });
      }

      const commission = await releaseOrderCommission(
        client,
        orderId
      );

      await client.query("COMMIT");
      transactionStarted = false;

      return res.json({
        success: true,

        message: commission.duplicate
          ? "Commission was already released."
          : "Delivered order commission processed successfully.",

        preparation,
        commission
      });

    } catch (error) {
      if (transactionStarted) {
        await client.query("ROLLBACK").catch(() => {});
      }

      if (error.message === "Order not found.") {
        return res.status(404).json({
          success: false,
          message: error.message
        });
      }

      const conflictMessages = [
        "Commission system is disabled.",
        "Commission engine is disabled.",
        "Required legal approval has not been confirmed.",
        "Only paid and delivered orders can enter the commission workflow.",
        "Only paid and delivered orders can release commission.",
        "Order does not have pending commission.",
        "A reversed order cannot be prepared for commission again.",
        "Commission ledger is incomplete. Expected exactly 10 levels.",
        "Commission ledger contains a non-pending entry.",
        "Company profit ledger not found.",
        "The order has no positive net profit. Commission cannot be calculated."
      ];

      if (conflictMessages.includes(error.message)) {
        return res.status(409).json({
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
// 9. ADMIN PENDING COMMISSION ORDERS
// GET /api/commission/admin/pending
// =====================================================

router.get(
  "/admin/pending",
  requireAdmin,
  async (req, res, next) => {
    try {
      const result = await pool.query(
        `
        SELECT
          o.id AS order_id,
          o.order_number,
          o.user_id,
          u.full_name AS customer_name,
          o.total_amount,
          o.delivered_at,
          o.refund_period_ends_at,
          o.commission_status,

          CASE
            WHEN o.refund_period_ends_at <= NOW()
            THEN TRUE
            ELSE FALSE
          END AS refund_period_completed,

          COALESCE(
            SUM(cl.amount),
            0
          ) AS commission_pool

        FROM orders o

        JOIN users u
          ON u.id = o.user_id

        LEFT JOIN commission_ledger cl
          ON cl.order_id = o.id

        WHERE o.status = 'delivered'
          AND o.payment_status = 'paid'
          AND o.commission_status = 'pending'

        GROUP BY o.id, u.full_name

        ORDER BY o.refund_period_ends_at ASC

        LIMIT 500
        `
      );

      return res.json({
        success: true,
        orders: result.rows
      });

    } catch (error) {
      next(error);
    }
  }
);


// =====================================================
// 10. ADMIN COMPANY PROFIT REPORT
// GET /api/commission/admin/report
//
// Total retained:
// company_share + unallocated_commission
// =====================================================

router.get(
  "/admin/report",
  requireAdmin,
  async (req, res, next) => {
    try {
      const totalsResult = await pool.query(
        `
        SELECT

          COALESCE(
            SUM(gross_profit),
            0
          ) AS net_profit,

          COALESCE(
            SUM(company_share),
            0
          ) AS company_share,

          COALESCE(
            SUM(unallocated_commission),
            0
          ) AS unallocated_commission,

          COALESCE(
            SUM(company_share + unallocated_commission),
            0
          ) AS total_company_retained,

          COUNT(*) AS total_orders

        FROM company_profit_ledger
        `
      );

      const levelsResult = await pool.query(
        `
        SELECT
          level,

          COUNT(*) FILTER (
            WHERE status = 'credited'
          ) AS credited_transactions,

          COUNT(*) FILTER (
            WHERE status = 'pending'
          ) AS pending_transactions,

          COUNT(*) FILTER (
            WHERE status = 'unallocated'
          ) AS unallocated_transactions,

          COUNT(*) FILTER (
            WHERE status = 'reversed'
          ) AS reversed_transactions,

          COALESCE(
            SUM(amount) FILTER (
              WHERE status = 'credited'
            ),
            0
          ) AS credited_amount,

          COALESCE(
            SUM(amount) FILTER (
              WHERE status = 'pending'
            ),
            0
          ) AS pending_amount,

          COALESCE(
            SUM(amount) FILTER (
              WHERE status = 'unallocated'
            ),
            0
          ) AS unallocated_amount,

          COALESCE(
            SUM(amount) FILTER (
              WHERE status = 'reversed'
            ),
            0
          ) AS reversed_amount

        FROM commission_ledger

        GROUP BY level

        ORDER BY level
        `
      );

      const debtResult = await pool.query(
        `
        SELECT
          COALESCE(
            SUM(original_amount - recovered_amount),
            0
          ) AS outstanding_reversal_debt,

          COUNT(*) FILTER (
            WHERE status IN ('open', 'partially_recovered')
          ) AS outstanding_debt_accounts

        FROM commission_reversal_debts
        `
      );

      const statusResult = await pool.query(
        `
        SELECT
          commission_status,
          COUNT(*) AS total_orders

        FROM orders

        GROUP BY commission_status

        ORDER BY commission_status
        `
      );

      return res.json({
        success: true,

        report: {
          totals: totalsResult.rows[0],
          levels: levelsResult.rows,
          reversalDebts: debtResult.rows[0],
          orderStatuses: statusResult.rows
        }
      });

    } catch (error) {
      next(error);
    }
  }
);


// =====================================================
// EXPORT ROUTER
// =====================================================

module.exports = router;
