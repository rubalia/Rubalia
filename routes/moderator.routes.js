"use strict";

const express = require("express");
const pool = require("../config/database");
const { authenticateToken } = require("../middleware/auth");

const router = express.Router();

/*
=====================================================
RUBALIA NETWORK — MODERATOR MANAGEMENT API

Base URL:
  /api/moderators

Admin only:
  GET    /
  GET    /search?email=
  POST   /
  PATCH  /:id
  DELETE /:id

Permissions:
  Products, Packages, Orders, Payments, Wallet,
  Commissions, Refunds, Support, Reports,
  Notifications

Actions:
  view, create, edit, delete
=====================================================
*/

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
   ADMIN ONLY
===================================================== */

function requireMainAdmin(req, res, next) {
  if (!req.auth || !req.auth.id) {
    return res.status(401).json({
      success: false,
      message: "Authentication required."
    });
  }

  if (req.auth.role !== "admin") {
    return res.status(403).json({
      success: false,
      message: "Only the Main Admin can manage moderators."
    });
  }

  next();
}

router.use(authenticateToken, requireMainAdmin);

/* =====================================================
   PERMISSION HELPERS
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
    if (
      input[moduleName] === undefined
    ) {
      continue;
    }

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

function publicPermissions(permissions) {
  const result = createEmptyPermissions();

  if (!permissions || typeof permissions !== "object") {
    return result;
  }

  for (const moduleName of MODULES) {
    for (const action of ACTIONS) {
      result[moduleName][action] =
        permissions[moduleName]?.[action] === true;
    }
  }

  return result;
}

function getModeratorId(req) {
  const id = String(req.params.id || "").trim();

  if (!/^[1-9]\d*$/.test(id)) {
    return null;
  }

  return id;
}

/* =====================================================
   GET /api/moderators
   List all moderators
===================================================== */

router.get("/", async (req, res, next) => {
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
       INNER JOIN users u
         ON u.id = m.user_id
       ORDER BY m.created_at DESC`
    );

    const moderators = result.rows.map(row => {
      const storedPermissions = row.permissions || {};

      return {
        id: row.id,
        user_id: row.user_id,
        full_name: row.full_name,
        email: row.email,
        role: row.role,
        user_status: row.user_status,
        status: row.moderator_status,
        permissions: publicPermissions(storedPermissions),
        created_by: row.created_by,
        created_at: row.created_at,
        updated_at: row.updated_at
      };
    });

    return res.json({
      success: true,
      count: moderators.length,
      moderators
    });

  } catch (error) {
    return next(error);
  }
});

/* =====================================================
   GET /api/moderators/search?email=
   Find an existing Customer or Partner account
===================================================== */

router.get("/search", async (req, res, next) => {
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
       LEFT JOIN moderators m
         ON m.user_id = u.id
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

    const user = result.rows[0];

    return res.json({
      success: true,
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        role: user.role,
        status: user.status,
        is_moderator: user.is_moderator
      }
    });

  } catch (error) {
    return next(error);
  }
});

/* =====================================================
   POST /api/moderators
   Assign Moderator role to an existing account

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
===================================================== */

router.post("/", async (req, res, next) => {
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
        message: "Main Admin cannot be assigned as a moderator."
      });
    }

    if (!["customer", "partner"].includes(user.role)) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(400).json({
        success: false,
        message: "This account role cannot be assigned as a moderator."
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
        message: "This user is already registered as a moderator."
      });
    }

    /*
      Keep the user's original role inside a reserved
      internal property so it can be restored when
      moderator access is revoked.

      This property is never returned to the frontend
      and is ignored by the permission middleware.
    */

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
      message: "Moderator assigned successfully. The user must log in again.",
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
        console.error(
          "Moderator assignment rollback failed:",
          rollbackError.message
        );
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
    if (client) {
      client.release();
    }
  }
});

/* =====================================================
   PATCH /api/moderators/:id
   Update moderator permissions or status

   Body:
   {
     "status": "active",
     "permissions": { ... }
   }

   status and permissions are optional.
===================================================== */

router.patch("/:id", async (req, res, next) => {
  const moderatorId = getModeratorId(req);

  if (!moderatorId) {
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
      message: "Please provide status or permissions to update."
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
    newPermissions = validatePermissions(
      req.body.permissions
    );

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
         u.role,
         u.status AS user_status
       FROM moderators m
       INNER JOIN users u
         ON u.id = m.user_id
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
        message: "Moderator account role is inconsistent. Please review this account."
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

/* =====================================================
   DELETE /api/moderators/:id
   Revoke moderator access and restore original role
===================================================== */

router.delete("/:id", async (req, res, next) => {
  const moderatorId = getModeratorId(req);

  if (!moderatorId) {
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
       INNER JOIN users u
         ON u.id = m.user_id
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
      message: "Moderator access revoked successfully. The user must log in again.",
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
        console.error(
          "Moderator removal rollback failed:",
          rollbackError.message
        );
      }
    }

    return next(error);

  } finally {
    if (client) {
      client.release();
    }
  }
});

module.exports = router;
