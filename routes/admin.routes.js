
"use strict";

const express = require("express");
const crypto = require("crypto");

const pool = require("../config/database");
const { authenticateToken } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/admin");

const router = express.Router();

const MODULES = [
  "Products",
  "Packages",
  "Orders",
  "Payments",
  "Wallet",
  "Commissions",
  "Refunds",
  "Support",
  "Reports",
  "Notifications"
];

const ACTIONS = ["view", "create", "edit", "delete"];

/* =====================================================
   HELPERS
===================================================== */

function createEmptyPermissions() {
  const permissions = {};

  for (const moduleName of MODULES) {
    permissions[moduleName] = {};

    for (const action of ACTIONS) {
      permissions[moduleName][action] = false;
    }
  }

  return permissions;
}

function validatePermissions(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    return null;
  }

  const permissions = createEmptyPermissions();

  for (const moduleName of MODULES) {
    if (input[moduleName] === undefined) continue;

    if (
      !input[moduleName] ||
      typeof input[moduleName] !== "object" ||
      Array.isArray(input[moduleName])
    ) {
      return null;
    }

    for (const action of ACTIONS) {
      if (input[moduleName][action] !== undefined) {
        if (typeof input[moduleName][action] !== "boolean") {
          return null;
        }

        permissions[moduleName][action] =
          input[moduleName][action];
      }
    }
  }

  return permissions;
}

function publicPermissions(input) {
  const result = createEmptyPermissions();

  if (!input || typeof input !== "object") {
    return result;
  }

  for (const moduleName of MODULES) {
    for (const action of ACTIONS) {
      result[moduleName][action] =
        input[moduleName]?.[action] === true;
    }
  }

  return result;
}

function validId(value) {
  return /^[1-9]\d*$/.test(String(value || ""));
}

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
   MODERATOR MANAGEMENT
===================================================== */

/*
   GET /api/admin/moderators
   List all moderators
*/

router.get("/moderators", async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT
         m.id,
         m.user_id,
         u.full_name,
         u.email,
         u.role,
         u.status AS user_status,
         m.status AS moderator_status,
         m.permissions,
         m.created_by,
         m.created_at,
         m.updated_at
       FROM moderators m
       INNER JOIN users u ON u.id = m.user_id
       ORDER BY m.created_at DESC`
    );

    const moderators = result.rows.map(row => ({
      id: row.id,
      user_id: row.user_id,
      full_name: row.full_name,
      email: row.email,
      role: row.role,
      user_status: row.user_status,
      status: row.moderator_status,
      permissions: publicPermissions(row.permissions),
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at
    }));

    return res.json({
      success: true,
      count: moderators.length,
      moderators
    });

  } catch (error) {
    return next(error);
  }
});


/*
   GET /api/admin/moderators/search?email=
   Find existing Customer or Partner
*/

router.get("/moderators/search", async (req, res, next) => {
  try {
    const email = String(req.query.email || "")
      .trim()
      .toLowerCase();

    if (!email || email.length > 255) {
      return res.status(400).json({
        success: false,
        message: "Please provide a valid email address."
      });
    }

    const result = await pool.query(
      `SELECT
         u.id,
         u.full_name,
         u.email,
         u.role,
         u.status,
         CASE
           WHEN m.id IS NOT NULL THEN TRUE
           ELSE FALSE
         END AS is_moderator
       FROM users u
       LEFT JOIN moderators m ON m.user_id = u.id
       WHERE LOWER(u.email) = $1
       LIMIT 1`,
      [email]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        success: false,
        message: "No registered account found with this email."
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


/*
   POST /api/admin/moderators

   Body:
   {
     "email": "user@example.com",
     "permissions": {
       "Products": {
         "view": true,
         "create": false,
         "edit": false,
         "delete": false
       }
     }
   }
*/

router.post("/moderators", async (req, res, next) => {
  const email = String(req.body?.email || "")
    .trim()
    .toLowerCase();

  if (!email || email.length > 255) {
    return res.status(400).json({
      success: false,
      message: "A valid registered email is required."
    });
  }

  const permissions = validatePermissions(
    req.body?.permissions || {}
  );

  if (!permissions) {
    return res.status(400).json({
      success: false,
      message: "Invalid permissions format."
    });
  }

  let client;
  let transactionStarted = false;

  try {
    client = await pool.connect();

    await client.query("BEGIN");
    transactionStarted = true;

    const userResult = await client.query(
      `SELECT id, full_name, email, role, status
       FROM users
       WHERE LOWER(email) = $1
       FOR UPDATE`,
      [email]
    );

    if (!userResult.rowCount) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(404).json({
        success: false,
        message: "Registered user not found."
      });
    }

    const user = userResult.rows[0];

    if (user.status !== "active") {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(400).json({
        success: false,
        message: "Inactive users cannot become moderators."
      });
    }

    if (user.role === "admin") {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(400).json({
        success: false,
        message: "Main Admin cannot become a moderator."
      });
    }

    if (!["customer", "partner"].includes(user.role)) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(400).json({
        success: false,
        message: "This account role cannot become a moderator."
      });
    }

    const existing = await client.query(
      `SELECT id
       FROM moderators
       WHERE user_id = $1
       LIMIT 1`,
      [user.id]
    );

    if (existing.rowCount) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(409).json({
        success: false,
        message: "This user is already a moderator."
      });
    }

    const storedPermissions = {
      ...permissions,
      _originalRole: user.role
    };

    await client.query(
      `INSERT INTO moderators (
         user_id,
         status,
         permissions,
         created_by,
         created_at,
         updated_at
       )
       VALUES ($1, 'active', $2::jsonb, $3, NOW(), NOW())`,
      [
        user.id,
        JSON.stringify(storedPermissions),
        req.auth.id
      ]
    );

    await client.query(
      `UPDATE users
       SET role = 'moderator',
           updated_at = NOW()
       WHERE id = $1`,
      [user.id]
    );

    await client.query("COMMIT");
    transactionStarted = false;

    return res.status(201).json({
      success: true,
      message: "Moderator assigned successfully. User must log in again.",
      moderator: {
        user_id: user.id,
        full_name: user.full_name,
        email: user.email,
        role: "moderator",
        status: "active",
        permissions
      }
    });

  } catch (error) {
    if (client && transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Moderator assignment rollback failed:", rollbackError.message);
      }
    }

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "This user already has a moderator record."
      });
    }

    return next(error);

  } finally {
    if (client) client.release();
  }
});


/*
   PATCH /api/admin/moderators/:id

   Body:
   {
     "status": "active",
     "permissions": { ... }
   }
*/

router.patch("/moderators/:id", async (req, res, next) => {
  const moderatorId = req.params.id;

  if (!validId(moderatorId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid moderator ID."
    });
  }

  const hasStatus = Object.prototype.hasOwnProperty.call(
    req.body || {},
    "status"
  );

  const hasPermissions = Object.prototype.hasOwnProperty.call(
    req.body || {},
    "permissions"
  );

  if (!hasStatus && !hasPermissions) {
    return res.status(400).json({
      success: false,
      message: "Status or permissions are required."
    });
  }

  let newStatus;

  if (hasStatus) {
    newStatus = String(req.body.status || "")
      .trim()
      .toLowerCase();

    if (!["active", "inactive"].includes(newStatus)) {
      return res.status(400).json({
        success: false,
        message: "Status must be active or inactive."
      });
    }
  }

  let newPermissions;

  if (hasPermissions) {
    newPermissions = validatePermissions(req.body.permissions);

    if (!newPermissions) {
      return res.status(400).json({
        success: false,
        message: "Invalid permissions format."
      });
    }
  }

  try {
    const currentResult = await pool.query(
      `SELECT
         m.id,
         m.user_id,
         m.status,
         m.permissions,
         u.full_name,
         u.email,
         u.role
       FROM moderators m
       INNER JOIN users u ON u.id = m.user_id
       WHERE m.id = $1
       LIMIT 1`,
      [moderatorId]
    );

    if (!currentResult.rowCount) {
      return res.status(404).json({
        success: false,
        message: "Moderator not found."
      });
    }

    const current = currentResult.rows[0];

    if (current.role !== "moderator") {
      return res.status(409).json({
        success: false,
        message: "Moderator account role is inconsistent."
      });
    }

    const storedPermissions = current.permissions || {};

    const updatedPermissions = hasPermissions
      ? {
          ...newPermissions,
          _originalRole:
            storedPermissions._originalRole || "customer"
        }
      : storedPermissions;

    const updatedStatus = hasStatus
      ? newStatus
      : current.status;

    await pool.query(
      `UPDATE moderators
       SET status = $1,
           permissions = $2::jsonb,
           updated_at = NOW()
       WHERE id = $3`,
      [
        updatedStatus,
        JSON.stringify(updatedPermissions),
        moderatorId
      ]
    );

    return res.json({
      success: true,
      message: "Moderator updated successfully.",
      moderator: {
        id: current.id,
        user_id: current.user_id,
        full_name: current.full_name,
        email: current.email,
        role: "moderator",
        status: updatedStatus,
        permissions: publicPermissions(updatedPermissions)
      }
    });

  } catch (error) {
    return next(error);
  }
});


/*
   DELETE /api/admin/moderators/:id
   Revoke moderator access
*/

router.delete("/moderators/:id", async (req, res, next) => {
  const moderatorId = req.params.id;

  if (!validId(moderatorId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid moderator ID."
    });
  }

  let client;
  let transactionStarted = false;

  try {
    client = await pool.connect();

    await client.query("BEGIN");
    transactionStarted = true;

    const result = await client.query(
      `SELECT
         m.id,
         m.user_id,
         m.permissions,
         u.role,
         u.full_name,
         u.email
       FROM moderators m
       INNER JOIN users u ON u.id = m.user_id
       WHERE m.id = $1
       FOR UPDATE OF m, u`,
      [moderatorId]
    );

    if (!result.rowCount) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(404).json({
        success: false,
        message: "Moderator not found."
      });
    }

    const moderator = result.rows[0];
    const storedPermissions = moderator.permissions || {};

    let originalRole = storedPermissions._originalRole;

    if (!["customer", "partner"].includes(originalRole)) {
      originalRole = "customer";
    }

    await client.query(
      `DELETE FROM moderators
       WHERE id = $1`,
      [moderatorId]
    );

    await client.query(
      `UPDATE users
       SET role = $1,
           updated_at = NOW()
       WHERE id = $2`,
      [originalRole, moderator.user_id]
    );

    await client.query("COMMIT");
    transactionStarted = false;

    return res.json({
      success: true,
      message: "Moderator access revoked successfully. User must log in again.",
      user: {
        id: moderator.user_id,
        full_name: moderator.full_name,
        email: moderator.email,
        restored_role: originalRole
      }
    });

  } catch (error) {
    if (client && transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Moderator removal rollback failed:", rollbackError.message);
      }
    }

    return next(error);

  } finally {
    if (client) client.release();
  }
});


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
        "customer",
        "partner",
        "moderator",
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

    await client.query(
      `UPDATE admin_messages
       SET active = FALSE,
           updated_at = NOW()
       WHERE active = TRUE`
    );

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
        console.error("Announcement rollback failed:", rollbackError.message);
      }
    }

    return next(error);

  } finally {
    if (client) client.release();
  }
});


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
