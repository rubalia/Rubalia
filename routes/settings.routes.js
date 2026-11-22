"use strict";

const express = require("express");
const bcrypt = require("bcryptjs");
const pool = require("../config/database");
const { authenticateToken } = require("../middleware/auth");

const router = express.Router();

router.use(authenticateToken);

// GET /api/settings
router.get("/", async (req, res, next) => {
  try {
    await pool.query(
      `INSERT INTO user_settings (user_id)
       VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
      [req.auth.id]
    );

    const result = await pool.query(
      `SELECT order_notifications, team_notifications,
              promotional_notifications, email_notifications,
              'en' AS language, updated_at
       FROM user_settings WHERE user_id = $1`,
      [req.auth.id]
    );

    return res.json({ success: true, settings: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// PUT /api/settings
router.put("/", async (req, res, next) => {
  try {
    const fields = [
      "orderNotifications",
      "teamNotifications",
      "promotionalNotifications",
      "emailNotifications"
    ];

    for (const field of fields) {
      if (typeof req.body?.[field] !== "boolean") {
        return res.status(400).json({
          success: false,
          message: `Invalid setting: ${field}.`
        });
      }
    }

    const result = await pool.query(
      `INSERT INTO user_settings (
         user_id, order_notifications, team_notifications,
         promotional_notifications, email_notifications,
         language, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, 'en', NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         order_notifications = EXCLUDED.order_notifications,
         team_notifications = EXCLUDED.team_notifications,
         promotional_notifications = EXCLUDED.promotional_notifications,
         email_notifications = EXCLUDED.email_notifications,
         language = 'en',
         updated_at = NOW()
       RETURNING order_notifications, team_notifications,
                 promotional_notifications, email_notifications,
                 'en' AS language, updated_at`,
      [
        req.auth.id,
        req.body.orderNotifications,
        req.body.teamNotifications,
        req.body.promotionalNotifications,
        req.body.emailNotifications
      ]
    );

    return res.json({
      success: true,
      message: "Settings saved successfully.",
      settings: result.rows[0]
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/settings/change-password
router.post("/change-password", async (req, res, next) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body || {};

    if (
      typeof currentPassword !== "string" ||
      typeof newPassword !== "string" ||
      typeof confirmPassword !== "string"
    ) {
      return res.status(400).json({
        success: false,
        message: "All password fields are required."
      });
    }

    if (newPassword.length < 8 || newPassword.length > 72) {
      return res.status(400).json({
        success: false,
        message: "New password must be 8 to 72 characters."
      });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({
        success: false,
        message: "New password and confirmation do not match."
      });
    }

    if (currentPassword === newPassword) {
      return res.status(400).json({
        success: false,
        message: "New password must be different from current password."
      });
    }

    const userResult = await pool.query(
      "SELECT password_hash FROM users WHERE id = $1",
      [req.auth.id]
    );

    if (!userResult.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Account not found."
      });
    }

    const valid = await bcrypt.compare(
      currentPassword,
      userResult.rows[0].password_hash
    );

    if (!valid) {
      return res.status(400).json({
        success: false,
        message: "Current password is incorrect."
      });
    }

    const hash = await bcrypt.hash(newPassword, 12);

    await pool.query(
      `UPDATE users SET password_hash = $1, updated_at = NOW()
       WHERE id = $2`,
      [hash, req.auth.id]
    );

    return res.json({
      success: true,
      message: "Password changed successfully. Please log in again on other devices."
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/settings/deactivation-request
router.post("/deactivation-request", async (req, res, next) => {
  try {
    const reason =
      typeof req.body?.reason === "string"
        ? req.body.reason.trim()
        : "";

    if (reason.length > 1000) {
      return res.status(400).json({
        success: false,
        message: "Reason must be 1000 characters or fewer."
      });
    }

    const pending = await pool.query(
      `SELECT id FROM account_deactivation_requests
       WHERE user_id = $1 AND status = 'pending'
       LIMIT 1`,
      [req.auth.id]
    );

    if (pending.rows.length) {
      return res.status(409).json({
        success: false,
        message: "You already have a pending deactivation request."
      });
    }

    const result = await pool.query(
      `INSERT INTO account_deactivation_requests (user_id, reason)
       VALUES ($1, $2)
       RETURNING id, status, created_at`,
      [req.auth.id, reason || null]
    );

    return res.status(201).json({
      success: true,
      message: "Account deactivation request submitted for admin review.",
      request: result.rows[0]
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/settings/deactivation-request
router.get("/deactivation-request", async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, reason, status, created_at, reviewed_at, admin_note
       FROM account_deactivation_requests
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [req.auth.id]
    );

    return res.json({
      success: true,
      request: result.rows[0] || null
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
