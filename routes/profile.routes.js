const express = require("express");

const pool = require("../config/database");
const { authenticateToken } = require("../middleware/auth");

const router = express.Router();

// GET /api/profile
router.get("/", authenticateToken, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, full_name, email, role, status, created_at, updated_at
       FROM users
       WHERE id = $1`,
      [req.auth.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Profile not found."
      });
    }

    return res.json({
      success: true,
      profile: result.rows[0]
    });
  } catch (error) {
    next(error);
  }
});

// PUT /api/profile
router.put("/", authenticateToken, async (req, res, next) => {
  try {
    const { fullName } = req.body;

    if (typeof fullName !== "string") {
      return res.status(400).json({
        success: false,
        message: "Full name is required."
      });
    }

    const cleanName = fullName.trim();

    if (cleanName.length < 2 || cleanName.length > 120) {
      return res.status(400).json({
        success: false,
        message: "Full name must be between 2 and 120 characters."
      });
    }

    const result = await pool.query(
      `UPDATE users
       SET full_name = $1,
           updated_at = NOW()
       WHERE id = $2
       RETURNING id, full_name, email, role, status, created_at, updated_at`,
      [cleanName, req.auth.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Profile not found."
      });
    }

    return res.json({
      success: true,
      message: "Profile updated successfully.",
      profile: result.rows[0]
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
