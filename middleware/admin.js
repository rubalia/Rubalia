
"use strict";

const pool = require("../config/database");

/* =====================================================
   RUBALIA NETWORK
   ADMIN + MODERATOR PERMISSION MIDDLEWARE

   Admin:
     Full administrative access.

   Moderator:
     Access only to assigned modules/actions.

   Actions:
     view, create, edit, delete

   IMPORTANT:
     Unknown routes/actions are denied.
===================================================== */

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

const ACTIONS = [
  "view",
  "create",
  "edit",
  "delete"
];

/* =====================================================
   NORMALIZE REQUEST PATH
===================================================== */

function getRequestPath(req) {
  const originalUrl = String(
    req.originalUrl || req.url || ""
  );

  return originalUrl
    .split("?")[0]
    .replace(/\/+/g, "/")
    .replace(/\/$/, "")
    .toLowerCase() || "/";
}

/* =====================================================
   CHECK PATH PREFIX
===================================================== */

function matchesPrefix(path, prefix) {
  return path === prefix ||
    path.startsWith(prefix + "/");
}

/* =====================================================
   IDENTIFY MODULE
===================================================== */

function getModule(path) {
  const moduleRoutes = [
    {
      prefix: "/api/products",
      module: "Products"
    },
    {
      prefix: "/api/packages",
      module: "Packages"
    },
    {
      prefix: "/api/orders",
      module: "Orders"
    },
    {
      prefix: "/api/payment",
      module: "Payments"
    },
    {
      prefix: "/api/wallet",
      module: "Wallet"
    },
    {
      prefix: "/api/commission",
      module: "Commissions"
    },
    {
      prefix: "/api/refunds",
      module: "Refunds"
    },
    {
      prefix: "/api/support",
      module: "Support"
    },
    {
      prefix: "/api/financial-reports",
      module: "Reports"
    },
    {
      prefix: "/api/notifications",
      module: "Notifications"
    }
  ];

  for (const route of moduleRoutes) {
    if (matchesPrefix(path, route.prefix)) {
      return route.module;
    }
  }

  return null;
}

/* =====================================================
   IDENTIFY ACTION

   GET / HEAD       = view
   DELETE           = delete
   PUT / PATCH      = edit

   POST:
     Known state-changing actions = edit
     Explicit create actions = create
     Other POST requests = create

   Unknown HTTP methods = denied
===================================================== */

function getAction(req) {
  const method = String(req.method || "")
    .trim()
    .toUpperCase();

  const path = getRequestPath(req);

  if (method === "GET" || method === "HEAD") {
    return "view";
  }

  if (method === "DELETE") {
    return "delete";
  }

  if (method === "PUT" || method === "PATCH") {
    return "edit";
  }

  if (method !== "POST") {
    return null;
  }

  const segments = path
    .split("/")
    .filter(Boolean);

  const lastSegment = segments[segments.length - 1] || "";

  /*
    Explicit create operations
  */

  const createActions = [
    "create",
    "add",
    "new",
    "store"
  ];

  if (createActions.includes(lastSegment)) {
    return "create";
  }

  /*
    Explicit edit / approval operations
  */

  const editActions = [
    "approve",
    "approved",
    "reject",
    "rejected",
    "cancel",
    "cancelled",
    "disable",
    "disabled",
    "enable",
    "enabled",
    "activate",
    "deactivate",
    "suspend",
    "unsuspend",
    "status",
    "update",
    "edit",
    "processing",
    "process",
    "paid",
    "mark-paid",
    "release",
    "retry",
    "confirm",
    "verify",
    "verified",
    "complete",
    "completed",
    "resolve",
    "close",
    "refund",
    "reverse",
    "publish",
    "unpublish",
    "assign",
    "remove",
    "restore"
  ];

  if (editActions.includes(lastSegment)) {
    return "edit";
  }

  /*
    Handle common action names with suffixes.

    Example:
      /approve-payment
      /reject-order
      /mark-paid
  */

  const editPrefixes = [
    "approve-",
    "reject-",
    "cancel-",
    "update-",
    "verify-",
    "confirm-",
    "process-",
    "complete-",
    "release-",
    "publish-",
    "disable-",
    "enable-",
    "activate-",
    "deactivate-",
    "mark-"
  ];

  if (
    editPrefixes.some(prefix =>
      lastSegment.startsWith(prefix)
    )
  ) {
    return "edit";
  }

  /*
    Default POST behavior:
    Create permission is required.

    For any custom POST endpoint that performs
    an approval or update, add its action name
    to editActions or editPrefixes above.
  */

  return "create";
}

/* =====================================================
   VERIFY MODERATOR PERMISSION FORMAT
===================================================== */

function hasPermission(permissions, moduleName, action) {
  if (
    !permissions ||
    typeof permissions !== "object" ||
    Array.isArray(permissions)
  ) {
    return false;
  }

  if (!MODULES.includes(moduleName)) {
    return false;
  }

  if (!ACTIONS.includes(action)) {
    return false;
  }

  const modulePermissions = permissions[moduleName];

  if (
    !modulePermissions ||
    typeof modulePermissions !== "object" ||
    Array.isArray(modulePermissions)
  ) {
    return false;
  }

  return modulePermissions[action] === true;
}

/* =====================================================
   MAIN ADMIN / MODERATOR MIDDLEWARE

   Existing routes already use:
     const { requireAdmin } = require("../middleware/admin");

   Therefore the exported middleware name remains
   unchanged to preserve existing route imports.
===================================================== */

async function requireAdmin(req, res, next) {
  try {

    /* -----------------------------------------------
       1. AUTHENTICATION CHECK
    ----------------------------------------------- */

    if (!req.auth || !req.auth.id) {
      return res.status(401).json({
        success: false,
        message: "Authentication required."
      });
    }

    const role = String(req.auth.role || "")
      .trim()
      .toLowerCase();

    /* -----------------------------------------------
       2. MAIN ADMIN

       Admin retains full access.
    ----------------------------------------------- */

    if (role === "admin") {
      return next();
    }

    /* -----------------------------------------------
       3. OTHER ROLES DENIED
    ----------------------------------------------- */

    if (role !== "moderator") {
      return res.status(403).json({
        success: false,
        message: "Admin access required."
      });
    }

    const path = getRequestPath(req);

    /* -----------------------------------------------
       4. BLOCK MAIN ADMIN API

       Moderator cannot access:
         /api/admin/*
    ----------------------------------------------- */

    if (matchesPrefix(path, "/api/admin")) {
      return res.status(403).json({
        success: false,
        message: "Main Admin access is restricted."
      });
    }

    /* -----------------------------------------------
       5. IDENTIFY MODULE AND ACTION
    ----------------------------------------------- */

    const moduleName = getModule(path);
    const action = getAction(req);

    if (!moduleName || !action) {
      return res.status(403).json({
        success: false,
        message: "This action is not available to moderators."
      });
    }

    /* -----------------------------------------------
       6. CHECK CURRENT DATABASE ACCOUNT

       Do not rely only on JWT role.

       This verifies that:
         - Moderator record exists.
         - Moderator is active.
         - User is active.
         - User role is still moderator.
    ----------------------------------------------- */

    const result = await pool.query(
      `SELECT
         m.id,
         m.permissions,
         m.status AS moderator_status,
         u.status AS user_status,
         u.role AS user_role
       FROM moderators m
       INNER JOIN users u
         ON u.id = m.user_id
       WHERE m.user_id = $1
       LIMIT 1`,
      [req.auth.id]
    );

    if (!result.rowCount) {
      return res.status(403).json({
        success: false,
        message: "Moderator account not found."
      });
    }

    const moderator = result.rows[0];

    /* -----------------------------------------------
       7. ACCOUNT STATUS CHECK
    ----------------------------------------------- */

    if (
      moderator.moderator_status !== "active" ||
      moderator.user_status !== "active" ||
      moderator.user_role !== "moderator"
    ) {
      return res.status(403).json({
        success: false,
        message: "Moderator account is inactive or access has been revoked."
      });
    }

    /* -----------------------------------------------
       8. PERMISSION CHECK
    ----------------------------------------------- */

    const permissions = moderator.permissions || {};

    const allowed = hasPermission(
      permissions,
      moduleName,
      action
    );

    if (!allowed) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission for this action.",
        module: moduleName,
        action
      });
    }

    /* -----------------------------------------------
       9. ACCESS GRANTED
    ----------------------------------------------- */

    return next();

  } catch (error) {
    console.error(
      "Admin/Moderator permission middleware error:",
      error.message
    );

    return next(error);
  }
}

/* =====================================================
   EXPORTS
===================================================== */

module.exports = {
  requireAdmin
};
