
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

/* =====================================================
   HELPERS
===================================================== */

const ALLOWED_AUDIENCES = {
  all: "u.status = 'active'",
  partners: "u.status = 'active' AND u.role = 'partner'",
  customers: "u.status = 'active' AND u.role = 'customer'"
};

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function validId(value) {
  return /^[1-9]\d*$/.test(String(value || ""));
}

function validateNotification(body) {
  const title = cleanText(body?.title);
  const message = cleanText(body?.message);
  const audience = cleanText(body?.audience || "all").toLowerCase();
  const link = cleanText(body?.link);

  if (title.length < 2 || title.length > 100) {
    return { error: "Title must contain 2 to 100 characters." };
  }

  if (message.length < 2 || message.length > 500) {
    return { error: "Message must contain 2 to 500 characters." };
  }

  if (!ALLOWED_AUDIENCES[audience]) {
    return { error: "Invalid notification audience." };
  }

  if (link) {
    try {
      const url = new URL(link);

      if (url.protocol !== "https:") {
        return { error: "Notification link must use HTTPS." };
      }
    } catch {
      return { error: "Invalid notification link." };
    }
  }

  return {
    value: {
      title,
      message,
      audience,
      link: link || null
    }
  };
}

/* =====================================================
   REGISTER DEVICE TOKEN
   POST /api/push/device-token
===================================================== */

router.post(
  "/device-token",
  authenticateToken,
  async (req, res, next) => {
    try {
      const token = cleanText(req.body?.token);

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
      return next(error);
    }
  }
);

/* =====================================================
   REMOVE DEVICE TOKEN
   DELETE /api/push/device-token
===================================================== */

router.delete(
  "/device-token",
  authenticateToken,
  async (req, res, next) => {
    try {
      const token = cleanText(req.body?.token);

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
      return next(error);
    }
  }
);

/* =====================================================
   GET SAVED NOTIFICATIONS
   GET /api/push/messages
===================================================== */

router.get(
  "/messages",
  authenticateToken,
  requireAdmin,
  async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT
          id,
          title,
          message,
          notification_link AS link,
          audience,
          status,
          recipient_count,
          device_count,
          success_count,
          failure_count,
          created_at,
          updated_at,
          sent_at
         FROM admin_push_messages
         ORDER BY created_at DESC
         LIMIT 200`
      );

      return res.json({
        success: true,
        messages: result.rows
      });

    } catch (error) {
      return next(error);
    }
  }
);

/* =====================================================
   SAVE NEW DRAFT
   POST /api/push/messages
===================================================== */

router.post(
  "/messages",
  authenticateToken,
  requireAdmin,
  async (req, res, next) => {
    try {
      const validation = validateNotification(req.body);

      if (validation.error) {
        return res.status(400).json({
          success: false,
          message: validation.error
        });
      }

      const item = validation.value;

      const result = await pool.query(
        `INSERT INTO admin_push_messages (
          title,
          message,
          notification_link,
          audience,
          status,
          created_by
        )
        VALUES ($1, $2, $3, $4, 'draft', $5)
        RETURNING *`,
        [
          item.title,
          item.message,
          item.link,
          item.audience,
          req.auth.id
        ]
      );

      return res.status(201).json({
        success: true,
        message: "Draft saved successfully.",
        notification: result.rows[0]
      });

    } catch (error) {
      return next(error);
    }
  }
);

/* =====================================================
   EDIT SAVED DRAFT
   PATCH /api/push/messages/:id
===================================================== */

router.patch(
  "/messages/:id",
  authenticateToken,
  requireAdmin,
  async (req, res, next) => {
    try {
      const id = req.params.id;

      if (!validId(id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid notification ID."
        });
      }

      const validation = validateNotification(req.body);

      if (validation.error) {
        return res.status(400).json({
          success: false,
          message: validation.error
        });
      }

      const item = validation.value;

      const result = await pool.query(
        `UPDATE admin_push_messages
         SET
           title = $1,
           message = $2,
           notification_link = $3,
           audience = $4,
           updated_at = NOW()
         WHERE id = $5
           AND status = 'draft'
         RETURNING *`,
        [
          item.title,
          item.message,
          item.link,
          item.audience,
          id
        ]
      );

      if (!result.rowCount) {
        return res.status(404).json({
          success: false,
          message: "Draft not found or it has already been sent."
        });
      }

      return res.json({
        success: true,
        message: "Draft updated successfully.",
        notification: result.rows[0]
      });

    } catch (error) {
      return next(error);
    }
  }
);

/* =====================================================
   DELETE SAVED NOTIFICATION
   DELETE /api/push/messages/:id
===================================================== */

router.delete(
  "/messages/:id",
  authenticateToken,
  requireAdmin,
  async (req, res, next) => {
    try {
      const id = req.params.id;

      if (!validId(id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid notification ID."
        });
      }

      const result = await pool.query(
        `DELETE FROM admin_push_messages
         WHERE id = $1
         RETURNING id`,
        [id]
      );

      if (!result.rowCount) {
        return res.status(404).json({
          success: false,
          message: "Notification not found."
        });
      }

      return res.json({
        success: true,
        message: "Notification deleted successfully."
      });

    } catch (error) {
      return next(error);
    }
  }
);

/* =====================================================
   SEND / RE-SEND SAVED NOTIFICATION
   POST /api/push/messages/:id/send
===================================================== */

async function broadcastNotification(item, adminId, existingId = null) {
  const client = await pool.connect();

  let recipientCount = 0;
  let tokens = [];

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
      WHERE ${ALLOWED_AUDIENCES[item.audience]}
      RETURNING user_id`,
      [item.title, item.message]
    );

    recipientCount = inserted.rowCount;

    const devices = await client.query(
      `SELECT d.token
       FROM push_devices d
       INNER JOIN users u ON u.id = d.user_id
       WHERE ${ALLOWED_AUDIENCES[item.audience]}`,
    );

    tokens = devices.rows.map(row => row.token);

    await client.query("COMMIT");

  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;

  } finally {
    client.release();
  }

  let pushResult = {
    successCount: 0,
    failureCount: 0,
    invalidTokens: []
  };

  let pushError = null;

  if (tokens.length) {
    try {
      pushResult = await sendPush(tokens, {
        title: item.title,
        message: item.message,
        link: item.link
      });

      if (pushResult.invalidTokens?.length) {
        await pool.query(
          `DELETE FROM push_devices
           WHERE token = ANY($1::text[])`,
          [pushResult.invalidTokens]
        );
      }

    } catch (error) {
      pushError = error.message;
      pushResult.failureCount = tokens.length;
    }
  }

  const status = pushError ? "failed" : "sent";

  let saved;

  if (existingId) {
    const result = await pool.query(
      `UPDATE admin_push_messages
       SET
         status = $1,
         recipient_count = $2,
         device_count = $3,
         success_count = $4,
         failure_count = $5,
         sent_at = NOW(),
         updated_at = NOW()
       WHERE id = $6
       RETURNING id`,
      [
        status,
        recipientCount,
        tokens.length,
        pushResult.successCount,
        pushResult.failureCount,
        existingId
      ]
    );

    saved = result.rows[0];

  } else {
    const result = await pool.query(
      `INSERT INTO admin_push_messages (
        title,
        message,
        notification_link,
        audience,
        status,
        recipient_count,
        device_count,
        success_count,
        failure_count,
        created_by,
        sent_at
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10, NOW()
      )
      RETURNING id`,
      [
        item.title,
        item.message,
        item.link,
        item.audience,
        status,
        recipientCount,
        tokens.length,
        pushResult.successCount,
        pushResult.failureCount,
        adminId
      ]
    );

    saved = result.rows[0];
  }

  return {
    id: saved.id,
    recipientCount,
    deviceCount: tokens.length,
    successCount: pushResult.successCount,
    failureCount: pushResult.failureCount,
    pushError
  };
}

router.post(
  "/messages/:id/send",
  authenticateToken,
  requireAdmin,
  async (req, res, next) => {
    try {
      const id = req.params.id;

      if (!validId(id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid notification ID."
        });
      }

      const result = await pool.query(
        `SELECT *
         FROM admin_push_messages
         WHERE id = $1`,
        [id]
      );

      if (!result.rowCount) {
        return res.status(404).json({
          success: false,
          message: "Saved notification not found."
        });
      }

      const saved = result.rows[0];

      const broadcast = await broadcastNotification({
        title: saved.title,
        message: saved.message,
        link: saved.notification_link,
        audience: saved.audience
      }, req.auth.id, id);

      return res.status(201).json({
        success: true,
        message: broadcast.pushError
          ? "In-app notifications were saved, but push delivery failed. Check Firebase configuration."
          : "Notification broadcast processed.",
        result: {
          total_devices: broadcast.deviceCount,
          sent: broadcast.successCount,
          failed: broadcast.failureCount,
          recipient_count: broadcast.recipientCount
        },
        notification_id: broadcast.id
      });

    } catch (error) {
      return next(error);
    }
  }
);

/* =====================================================
   DIRECT BROADCAST
   POST /api/push/broadcast

   Also saves every broadcast in server history.
===================================================== */

router.post(
  "/broadcast",
  authenticateToken,
  requireAdmin,
  async (req, res, next) => {
    try {
      const validation = validateNotification(req.body);

      if (validation.error) {
        return res.status(400).json({
          success: false,
          message: validation.error
        });
      }

      const result = await broadcastNotification(
        validation.value,
        req.auth.id
      );

      return res.status(201).json({
        success: true,
        message: result.pushError
          ? "In-app notifications were saved, but push delivery failed. Check Firebase configuration."
          : "Broadcast processed and saved to server history.",
        result: {
          total_devices: result.deviceCount,
          sent: result.successCount,
          failed: result.failureCount,
          recipient_count: result.recipientCount
        },
        notification_id: result.id
      });

    } catch (error) {
      return next(error);
    }
  }
);

module.exports = router;
