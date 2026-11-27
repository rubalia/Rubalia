
"use strict";

// =====================================================
// RUBALIA NETWORK
// RECENT COMMISSION API
// Shows latest 20 real credited commission transactions
// =====================================================

const express = require("express");
const pool = require("../config/database");
const { authenticateToken } = require("../middleware/auth");

const router = express.Router();

// Login required
router.use(authenticateToken);

// Mask member name to protect privacy
function maskMemberName(fullName) {
  const name = String(fullName || "").trim();

  if (!name) return "Member";

  return name.split(/\s+/).map(part => {
    const chars = Array.from(part);

    if (chars.length === 1) {
      return chars[0] + "***";
    }

    if (chars.length === 2) {
      return chars[0] + "*";
    }

    return (
      chars.slice(0, 2).join("") +
      "*".repeat(Math.max(2, chars.length - 3)) +
      chars[chars.length - 1]
    );
  }).join(" ");
}

// =====================================================
// GET /api/recent-commissions
// Latest 20 credited commission transactions
// =====================================================

router.get("/", async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT
        u.full_name,
        cl.amount

      FROM commission_ledger cl

      INNER JOIN users u
        ON u.id = cl.beneficiary_id

      WHERE cl.status = 'credited'
        AND cl.wallet_transaction_id IS NOT NULL

      ORDER BY
        cl.released_at DESC NULLS LAST,
        cl.created_at DESC,
        cl.id DESC

      LIMIT 20
    `);

    const commissions = result.rows.map(row => ({
      memberName: maskMemberName(row.full_name),
      amount: Number(row.amount)
    }));

    res.set("Cache-Control", "no-store");

    return res.json({
      success: true,
      count: commissions.length,
      commissions
    });

  } catch (error) {
    console.error("Recent commission API error:", error.message);
    next(error);
  }
});

module.exports = router;
