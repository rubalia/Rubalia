"use strict";

const express = require("express");
const pool = require("../config/database");

const {
  authenticateToken
} = require("../middleware/auth");

const {
  requireAdmin
} = require("../middleware/admin");

const {
  sendPush
} = require("../services/firebase-admin");

const router = express.Router();

/* REGISTER DEVICE TOKEN */

router.post(
  "/device-token",
  authenticateToken,
  async (req, res, next) => {
    try {
      const token =
        typeof req.body?.token === "string"
          ? req.body.token.trim()
          : "";

      if (token.length < 50 || token.length > 4096) {
        return res.status(400).json({
          success: false,
          message: "Invalid device token."
        });
      }

      await pool.query(
        `INSERT INTO push_devices (
          user_id,
          token,
          platform,
          updated_at,
          last_seen_at
        )
        VALUES ($1, $2, 'android', NOW(), NOW())
        ON CONFLICT (token)
        DO UPDATE SET
          user_id = EXCLUDED.user_id,
          platform = 'android',
          updated_at = NOW(),
          last_seen_at = NOW()`,
        [req.auth.id, token]
      );

      return res.json({
        success: true,
        message: "Device registered successfully."
      });

    } catch (error) {
      next(error);
    }
  }
);

/* REMOVE DEVICE TOKEN */

router.delete(
  "/device-token",
  authenticateToken,
  async (req, res, next) => {
    try {
      const token =
        typeof req.body?.token === "string"
          ? req.body.token.trim()
          : "";

      if (!token) {
        return res.status(400).json({
          success: false,
          message: "Device token required."
        });
      }

      await pool.query(
        `DELETE FROM push_devices
         WHERE user_id = $1 AND token = $2`,
        [req.auth.id, token]
      );

      return res.json({
        success: true,
        message: "Device removed."
      });

    } catch (error) {
      next(error);
    }
  }
);

/* ADMIN BROADCAST */

router.post(
  "/broadcast",
  authenticateToken,
  requireAdmin,
  async (req, res, next) => {
    const title =
      typeof req.body?.title === "string"
        ? req.body.title.trim()
        : "";

    const message =
      typeof req.body?.message === "string"
        ? req.body.message.trim()
        : "";

    const audience = String(
      req.body?.audience || "all"
    ).toLowerCase();

    const allowedAudiences = {
      all: "u.status = 'active'",
      partners: "u.status = 'active' AND u.role = 'partner'",
      customers: "u.status = 'active' AND u.role = 'customer'"
    };

    if (
      title.length < 2 ||
      title.length > 180 ||
      message.length < 2 ||
      message.length > 1000
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid title or message."
      });
    }

    if (!allowedAudiences[audience]) {
      return res.status(400).json({
        success: false,
        message: "Invalid audience."
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const inserted = await client.query(
        `INSERT INTO notifications (
          user_id,
          title,
          message,
          notification_type
        )
        SELECT
          u.id,
          $1,
          $2,
          'announcement'
        FROM users u
        WHERE ${allowedAudiences[audience]}
        RETURNING user_id`,
        [title, message]
      );

      await client.query("COMMIT");

      const devices = await pool.query(
        `SELECT d.token
         FROM push_devices d
         INNER JOIN users u ON u.id = d.user_id
         WHERE ${allowedAudiences[audience]}`
      );

      const tokens = devices.rows.map(row => row.token);

      let pushResult = {
        successCount: 0,
        failureCount: 0,
        invalidTokens: []
      };

      if (tokens.length) {
        pushResult = await sendPush(tokens, {
          title,
          message
        });

        if (pushResult.invalidTokens.length) {
          await pool.query(
            `DELETE FROM push_devices
             WHERE token = ANY($1::text[])`,
            [pushResult.invalidTokens]
          );
        }
      }

      return res.status(201).json({
        success: true,
        message: "Broadcast processed.",
        recipientCount: inserted.rowCount,
        deviceCount: tokens.length,
        pushSuccessCount: pushResult.successCount,
        pushFailureCount: pushResult.failureCount
      });

    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      next(error);

    } finally {
      client.release();
    }
  }
);

module.exports = router;
