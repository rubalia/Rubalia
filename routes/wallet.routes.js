const express = require("express");

const pool = require("../config/database");
const { authenticateToken } = require("../middleware/auth");

const router = express.Router();

// GET /api/wallet
// View the logged-in user's wallet.
router.get("/", authenticateToken, async (req, res, next) => {
  try {
    const walletResult = await pool.query(
      `INSERT INTO wallets (user_id)
       VALUES ($1)
       ON CONFLICT (user_id)
       DO UPDATE SET user_id = EXCLUDED.user_id
       RETURNING id, user_id, balance, currency, created_at, updated_at`,
      [req.auth.id]
    );

    return res.json({
      success: true,
      wallet: walletResult.rows[0]
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/wallet/transactions
// View the logged-in user's transaction history.
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

      if (walletResult.rows.length === 0) {
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

module.exports = router;
