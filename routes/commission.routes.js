
"use strict";

// =====================================================
// RUBALIA NETWORK
// COMMISSION API ROUTES
// 10 LEVEL UNILEVEL SYSTEM
// =====================================================

const express = require("express");

const pool = require("../config/database");

const { authenticateToken } = require("../middleware/auth");

const { requireAdmin } = require("../middleware/admin");

const {
  releaseOrderCommission,
  DEFAULT_RATES
} = require("../services/commission.service");

const router = express.Router();


// =====================================================
// MEMBER AUTHENTICATION
// All routes require login.
// =====================================================

router.use(authenticateToken);


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
          ),
          0
        ) AS total_earned,

        COALESCE(
          SUM(amount) FILTER (
            WHERE status = 'reversed'
          ),
          0
        ) AS total_reversed,

        COUNT(*) FILTER (
          WHERE status = 'credited'
        ) AS total_transactions

      FROM commission_ledger

      WHERE beneficiary_id = $1
      `,
      [memberId]
    );

    const summary = summaryResult.rows[0];

    return res.json({
      success: true,

      income: {
        totalEarned: Number(summary.total_earned),
        totalReversed: Number(summary.total_reversed),
        totalTransactions: Number(summary.total_transactions)
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

    const memberId = req.auth.id;

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
        cl.created_at

      FROM commission_ledger cl

      INNER JOIN orders o
        ON o.id = cl.order_id

      WHERE cl.beneficiary_id = $1

      ORDER BY cl.created_at DESC

      LIMIT 200
      `,
      [memberId]
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

      const rates =
        req.body.levelRates ?? DEFAULT_RATES;


      // Validate gateway fee.

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


      // Validate all 10 levels.

      if (
        !Array.isArray(rates) ||
        rates.length !== 10 ||
        rates.some(
          rate =>
            !Number.isFinite(Number(rate)) ||
            Number(rate) < 0 ||
            Number(rate) > 75
        )
      ) {
        return res.status(400).json({
          success: false,
          message: "Exactly 10 valid commission rates are required."
        });
      }

      const totalRate = rates.reduce(
        (sum, rate) => sum + Number(rate),
        0
      );

      if (Math.abs(totalRate - 75) > 0.0001) {
        return res.status(400).json({
          success: false,
          message: "The 10 commission levels must total exactly 75%."
        });
      }


      // Live commission activation requires explicit approval confirmation.

      if (enabled && !legalApprovalConfirmed) {
        return res.status(409).json({
          success: false,
          message: "Required legal approval must be confirmed before enabling commissions."
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

          updated_by = $5,

          updated_at = NOW()

        WHERE id = 1

        RETURNING *
        `,
        [
          enabled,
          legalApprovalConfirmed,
          gatewayFeePercent,
          JSON.stringify(rates.map(Number)),
          req.auth.id
        ]
      );

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

      const costPrice = Number(req.body.costPrice ?? 0);

      const deliveryCost = Number(req.body.deliveryCost ?? 0);

      const packagingCost = Number(req.body.packagingCost ?? 0);

      const otherCost = Number(req.body.otherCost ?? 0);


      if (
        !Number.isSafeInteger(productId) ||
        productId <= 0
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid product ID."
        });
      }


      const costs = [
        costPrice,
        deliveryCost,
        packagingCost,
        otherCost
      ];

      if (
        costs.some(
          value =>
            !Number.isFinite(value) ||
            value < 0 ||
            value > 9999999999
        )
      ) {
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

      const deliveryCost = Number(req.body.deliveryCost ?? 0);

      const packagingCost = Number(req.body.packagingCost ?? 0);

      const otherCost = Number(req.body.otherCost ?? 0);


      if (
        !Number.isSafeInteger(packageId) ||
        packageId <= 0
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid package ID."
        });
      }


      const costs = [
        deliveryCost,
        packagingCost,
        otherCost
      ];

      if (
        costs.some(
          value =>
            !Number.isFinite(value) ||
            value < 0 ||
            value > 9999999999
        )
      ) {
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

    const client = await pool.connect();

    let transactionStarted = false;

    try {

      const orderId = Number(req.params.id);

      if (
        !Number.isSafeInteger(orderId) ||
        orderId <= 0
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid order ID."
        });
      }


      await client.query("BEGIN");

      transactionStarted = true;


      // The service checks:
      // - Commission settings
      // - Legal approval confirmation
      // - Paid order
      // - Delivered order
      // - Duplicate commission
      // - Actual order profit
      // - Ten-level sponsor chain

      const commission = await releaseOrderCommission(
        client,
        orderId
      );


      await client.query("COMMIT");

      transactionStarted = false;


      return res.json({
        success: true,
        message: "Order commission processed successfully.",
        commission
      });

    } catch (error) {

      if (transactionStarted) {
        await client.query("ROLLBACK").catch(() => {});
      }

      if (
        error.message === "Commission engine is disabled." ||
        error.message === "Required legal approval has not been confirmed." ||
        error.message === "Commission has already been processed for this order." ||
        error.message === "Only paid and delivered orders are eligible for commission."
      ) {
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
// 8. ADMIN COMPANY PROFIT REPORT
// GET /api/commission/admin/report
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
          ) AS gross_profit,

          COALESCE(
            SUM(company_share),
            0
          ) AS company_share,

          COALESCE(
            SUM(unallocated_commission),
            0
          ) AS unallocated_commission,

          COUNT(*) AS total_orders

        FROM company_profit_ledger
        `
      );


      const levelsResult = await pool.query(
        `
        SELECT

          level,

          COUNT(*) AS total_transactions,

          COALESCE(
            SUM(amount),
            0
          ) AS total_commission

        FROM commission_ledger

        WHERE status = 'credited'

        GROUP BY level

        ORDER BY level
        `
      );


      return res.json({
        success: true,

        report: {
          totals: totalsResult.rows[0],
          levels: levelsResult.rows
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
