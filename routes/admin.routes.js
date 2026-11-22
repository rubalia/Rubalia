
const express = require("express");
const crypto = require("crypto");

const pool = require("../config/database");
const { authenticateToken } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/admin");

const router = express.Router();

/* =====================================================
   ONE-TIME ADMIN SETUP
   POST /api/admin/setup
===================================================== */

router.post("/setup", async (req, res, next) => {
  const providedKey = req.get("x-admin-setup-key") || "";
  const expectedKey = process.env.ADMIN_SETUP_KEY || "";

  const providedBuffer = Buffer.from(providedKey, "utf8");
  const expectedBuffer = Buffer.from(expectedKey, "utf8");

  if (
    !expectedKey ||
    providedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return res.status(403).json({
      success: false,
      message: "Invalid setup authorization."
    });
  }

  const email =
    typeof req.body.email === "string"
      ? req.body.email.trim().toLowerCase()
      : "";

  if (!email || email.length > 254) {
    return res.status(400).json({
      success: false,
      message: "A valid registered email is required."
    });
  }

  let client;
  let transactionStarted = false;

  try {
    client = await pool.connect();

    await client.query("BEGIN");
    transactionStarted = true;

    await client.query(
      "SELECT pg_advisory_xact_lock($1)",
      [72819463]
    );

    const adminCheck = await client.query(
      `SELECT id
       FROM users
       WHERE role = 'admin'
       LIMIT 1`
    );

    if (adminCheck.rowCount > 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(409).json({
        success: false,
        message: "An admin account already exists. Setup is closed."
      });
    }

    const userResult = await client.query(
      `UPDATE users
       SET role = 'admin',
           updated_at = NOW()
       WHERE LOWER(email) = $1
         AND status = 'active'
       RETURNING id, full_name, email, role, status`,
      [email]
    );

    if (userResult.rowCount === 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(404).json({
        success: false,
        message: "Active registered account not found."
      });
    }

    await client.query("COMMIT");
    transactionStarted = false;

    return res.json({
      success: true,
      message: "Admin account created successfully. Please log in again.",
      user: userResult.rows[0]
    });

  } catch (error) {
    if (client && transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Admin setup rollback error:", rollbackError);
      }
    }

    return next(error);

  } finally {
    if (client) client.release();
  }
});


/* =====================================================
   ADMIN AUTHENTICATION
===================================================== */

router.use(authenticateToken, requireAdmin);


/* =====================================================
   DASHBOARD
   GET /api/admin/dashboard
===================================================== */

router.get("/dashboard", async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users)::BIGINT AS total_users,

        (SELECT COUNT(*)
         FROM users
         WHERE status = 'active')::BIGINT AS active_users,

        (SELECT COUNT(*) FROM products)::BIGINT AS total_products,

        (SELECT COUNT(*)
         FROM products
         WHERE status = 'active')::BIGINT AS active_products,

        (SELECT COUNT(*) FROM orders)::BIGINT AS total_orders,

        (SELECT COUNT(*)
         FROM orders
         WHERE status = 'pending')::BIGINT AS pending_orders,

        (SELECT COUNT(*)
         FROM orders
         WHERE status = 'delivered')::BIGINT AS delivered_orders
    `);

    return res.json({
      success: true,
      dashboard: result.rows[0]
    });

  } catch (error) {
    return next(error);
  }
});


/* =====================================================
   USER STATISTICS
   GET /api/admin/users/stats
===================================================== */

router.get("/users/stats", async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*)::BIGINT AS total_users,

        COUNT(*) FILTER (
          WHERE status = 'active'
        )::BIGINT AS active_users,

        COUNT(*) FILTER (
          WHERE status = 'inactive'
        )::BIGINT AS inactive_users,

        COUNT(*) FILTER (
          WHERE role = 'partner'
        )::BIGINT AS partners

      FROM users
    `);

    const stats = result.rows[0];

    return res.json({
      success: true,
      stats: {
        total_users: Number(stats.total_users),
        active_users: Number(stats.active_users),
        inactive_users: Number(stats.inactive_users),
        partners: Number(stats.partners)
      }
    });

  } catch (error) {
    return next(error);
  }
});


/* =====================================================
   GET ALL USERS
   GET /api/admin/users
===================================================== */

router.get("/users", async (req, res, next) => {
  try {
    const page = Math.max(
      1,
      Number.parseInt(req.query.page, 10) || 1
    );

    const limit = Math.min(
      100,
      Math.max(
        1,
        Number.parseInt(req.query.limit, 10) || 20
      )
    );

    const offset = (page - 1) * limit;

    const search =
      typeof req.query.search === "string"
        ? req.query.search.trim().slice(0, 100)
        : "";

    const status =
      typeof req.query.status === "string"
        ? req.query.status.trim().toLowerCase()
        : "";

    const role =
      typeof req.query.role === "string"
        ? req.query.role.trim().toLowerCase()
        : "";

    const conditions = [];
    const values = [];

    if (search) {
      values.push(`%${search}%`);
      const searchIndex = values.length;

      conditions.push(`
        (
          full_name ILIKE $${searchIndex}
          OR email ILIKE $${searchIndex}
          OR id::TEXT ILIKE $${searchIndex}
        )
      `);
    }

    if (status) {
      const allowedStatuses = [
        "active",
        "inactive",
        "suspended"
      ];

      if (!allowedStatuses.includes(status)) {
        return res.status(400).json({
          success: false,
          message: "Invalid user status filter."
        });
      }

      values.push(status);
      conditions.push(`status = $${values.length}`);
    }

    if (role) {
      const allowedRoles = [
        "user",
        "partner",
        "admin"
      ];

      if (!allowedRoles.includes(role)) {
        return res.status(400).json({
          success: false,
          message: "Invalid user role filter."
        });
      }

      values.push(role);
      conditions.push(`role = $${values.length}`);
    }

    const whereClause = conditions.length
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    const countResult = await pool.query(
      `SELECT COUNT(*)::BIGINT AS total
       FROM users
       ${whereClause}`,
      values
    );

    const total = Number(countResult.rows[0].total);

    const listValues = [
      ...values,
      limit,
      offset
    ];

    const usersResult = await pool.query(
      `SELECT
        id,
        full_name,
        email,
        role,
        status,
        sponsor_id,
        created_at,
        updated_at
       FROM users
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${values.length + 1}
       OFFSET $${values.length + 2}`,
      listValues
    );

    return res.json({
      success: true,

      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      },

      users: usersResult.rows
    });

  } catch (error) {
    return next(error);
  }
});


/* =====================================================
   SINGLE USER DETAILS
   GET /api/admin/users/:id
===================================================== */

router.get("/users/:id", async (req, res, next) => {
  try {
    const userId = req.params.id;

    if (!userId || userId.length > 100) {
      return res.status(400).json({
        success: false,
        message: "Invalid user ID."
      });
    }

    const result = await pool.query(
      `SELECT
        id,
        full_name,
        email,
        role,
        status,
        sponsor_id,
        created_at,
        updated_at
       FROM users
       WHERE id::TEXT = $1
       LIMIT 1`,
      [userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found."
      });
    }

    return res.json({
      success: true,
      user: result.rows[0]
    });

  } catch (error) {
    return next(error);
  }
});


/* =====================================================
   ADMIN ORDERS
   GET /api/admin/orders
===================================================== */

router.get("/orders", async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT
        o.id,
        o.order_number,
        o.user_id,
        u.full_name AS customer_name,
        u.email AS customer_email,
        o.total_amount,
        o.status,
        o.created_at
       FROM orders o
       JOIN users u ON u.id = o.user_id
       ORDER BY o.created_at DESC
       LIMIT 100`
    );

    return res.json({
      success: true,
      orders: result.rows
    });

  } catch (error) {
    return next(error);
  }
});


/* =====================================================
   ADMIN ANNOUNCEMENTS
===================================================== */

/*
   GET /api/admin/messages
   Announcement History
*/

router.get("/messages", async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT
        id,
        text,
        active,
        updated_by,
        created_at,
        updated_at
       FROM admin_messages
       ORDER BY updated_at DESC, id DESC
       LIMIT 50`
    );

    return res.json({
      success: true,
      messages: result.rows
    });

  } catch (error) {
    return next(error);
  }
});


/*
   POST /api/admin/messages
   Publish Announcement
*/

router.post("/messages", async (req, res, next) => {
  const text = typeof req.body?.text === "string"
    ? req.body.text.trim()
    : "";

  if (!text || text.length > 300) {
    return res.status(400).json({
      success: false,
      message: "Announcement must contain 1 to 300 characters."
    });
  }

  let client;
  let transactionStarted = false;

  try {
    client = await pool.connect();

    await client.query("BEGIN");
    transactionStarted = true;

    // Disable previous running announcement.
    await client.query(
      `UPDATE admin_messages
       SET active = FALSE,
           updated_at = NOW()
       WHERE active = TRUE`
    );

    // Publish new announcement.
    const result = await client.query(
      `INSERT INTO admin_messages (
        text,
        active,
        updated_by
      )
      VALUES ($1, TRUE, $2)
      RETURNING
        id,
        text,
        active,
        updated_by,
        created_at,
        updated_at`,
      [text, req.auth.id]
    );

    await client.query("COMMIT");
    transactionStarted = false;

    return res.status(201).json({
      success: true,
      message: "Announcement published successfully.",
      data: result.rows[0]
    });

  } catch (error) {
    if (client && transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error(
          "Announcement rollback failed:",
          rollbackError.message
        );
      }
    }

    return next(error);

  } finally {
    if (client) client.release();
  }
});


/*
   POST /api/admin/messages/disable
   Disable Running Announcement
*/

router.post("/messages/disable", async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE admin_messages
       SET active = FALSE,
           updated_at = NOW()
       WHERE active = TRUE
       RETURNING id`
    );

    return res.json({
      success: true,
      message: result.rowCount
        ? "Running announcement disabled."
        : "There is no active announcement."
    });

  } catch (error) {
    return next(error);
  }
});


module.exports = router;
