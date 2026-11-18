const express = require("express");

const pool = require("../config/database");
const { authenticateToken } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/admin");

const router = express.Router();

// GET /api/notifications
// Member: View own notifications.
router.get("/", authenticateToken, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT
        id,
        title,
        message,
        notification_type,
        is_read,
        created_at
       FROM notifications
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [req.auth.id]
    );

    return res.json({
      success: true,
      notifications: result.rows
    });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/notifications/:id/read
// Member: Mark one notification as read.
router.patch("/:id/read", authenticateToken, async (req, res, next) => {
  try {
    const notificationId = Number(req.params.id);

    if (!Number.isSafeInteger(notificationId) || notificationId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid notification ID."
      });
    }

    const result = await pool.query(
      `UPDATE notifications
       SET is_read = TRUE
       WHERE id = $1 AND user_id = $2
       RETURNING id, is_read`,
      [notificationId, req.auth.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Notification not found."
      });
    }

    return res.json({
      success: true,
      message: "Notification marked as read.",
      notification: result.rows[0]
    });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/notifications/read-all
// Member: Mark all own notifications as read.
router.patch("/read-all", authenticateToken, async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE notifications
       SET is_read = TRUE
       WHERE user_id = $1 AND is_read = FALSE`,
      [req.auth.id]
    );

    return res.json({
      success: true,
      message: "All notifications marked as read.",
      updatedCount: result.rowCount
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/notifications/admin/broadcast
// Admin: Send a notification to all users.
router.post(
  "/admin/broadcast",
  authenticateToken,
  requireAdmin,
  async (req, res, next) => {
    const client = await pool.connect();

    try {
      const { title, message, notificationType } = req.body;

      const cleanTitle =
        typeof title === "string" ? title.trim() : "";

      const cleanMessage =
        typeof message === "string" ? message.trim() : "";

      const cleanType =
        typeof notificationType === "string"
          ? notificationType.trim()
          : "general";

      if (
        cleanTitle.length < 2 ||
        cleanTitle.length > 180 ||
        cleanMessage.length < 2 ||
        cleanMessage.length > 5000
      ) {
        return res.status(400).json({
          success: false,
          message: "Provide a valid title and message."
        });
      }

      const allowedTypes = [
        "general",
        "announcement",
        "order",
        "account",
        "system"
      ];

      if (!allowedTypes.includes(cleanType)) {
        return res.status(400).json({
          success: false,
          message: "Invalid notification type."
        });
      }

      await client.query("BEGIN");

      const result = await client.query(
        `INSERT INTO notifications (
          user_id,
          title,
          message,
          notification_type
        )
        SELECT id, $1, $2, $3
        FROM users
        WHERE status = 'active'
        RETURNING id`,
        [cleanTitle, cleanMessage, cleanType]
      );

      await client.query("COMMIT");

      return res.status(201).json({
        success: true,
        message: "Notification sent to active users.",
        recipientCount: result.rowCount
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
