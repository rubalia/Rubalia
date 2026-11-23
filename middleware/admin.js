
"use strict";

const pool = require("../config/database");

function getModule(path) {
  if (path.startsWith("/api/products")) return "Products";
  if (path.startsWith("/api/packages")) return "Packages";
  if (path.startsWith("/api/orders")) return "Orders";
  if (path.startsWith("/api/payment")) return "Payments";
  if (path.startsWith("/api/wallet")) return "Wallet";
  if (path.startsWith("/api/commission")) return "Commissions";
  if (path.startsWith("/api/refunds")) return "Refunds";
  if (path.startsWith("/api/support")) return "Support";
  if (path.startsWith("/api/financial-reports")) return "Reports";
  if (path.startsWith("/api/notifications")) return "Notifications";
  return null;
}

function getAction(req) {
  const method = req.method.toUpperCase();

  if (method === "GET" || method === "HEAD") return "view";
  if (method === "DELETE") return "delete";

  if (method === "POST") {
    const path = req.originalUrl.toLowerCase();

    if (
      path.includes("/approve") ||
      path.includes("/reject") ||
      path.includes("/status") ||
      path.includes("/processing") ||
      path.includes("/paid") ||
      path.includes("/release") ||
      path.includes("/retry") ||
      path.includes("/confirm")
    ) {
      return "edit";
    }

    return "create";
  }

  if (method === "PUT" || method === "PATCH") {
    return "edit";
  }

  return null;
}

async function requireAdmin(req, res, next) {
  try {
    if (!req.auth) {
      return res.status(401).json({
        success: false,
        message: "Authentication required."
      });
    }

    if (req.auth.role === "admin") {
      return next();
    }

    if (req.auth.role !== "moderator") {
      return res.status(403).json({
        success: false,
        message: "Admin access required."
      });
    }

    // Moderator cannot enter the main Admin API.
    if (req.originalUrl.startsWith("/api/admin")) {
      return res.status(403).json({
        success: false,
        message: "Main Admin access is restricted."
      });
    }

    const moduleName = getModule(req.originalUrl);
    const action = getAction(req);

    if (!moduleName || !action) {
      return res.status(403).json({
        success: false,
        message: "This action is not available to moderators."
      });
    }

    const result = await pool.query(
      `SELECT m.permissions
       FROM moderators m
       JOIN users u ON u.id = m.user_id
       WHERE m.user_id = $1
         AND m.status = 'active'
         AND u.status = 'active'
         AND u.role = 'moderator'
       LIMIT 1`,
      [req.auth.id]
    );

    if (!result.rowCount) {
      return res.status(403).json({
        success: false,
        message: "Moderator account is inactive."
      });
    }

    const permissions = result.rows[0].permissions || {};
    const modulePermissions = permissions[moduleName] || {};

    if (modulePermissions[action] !== true) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission for this action.",
        module: moduleName,
        action
      });
    }

    return next();

  } catch (error) {
    return next(error);
  }
}

module.exports = { requireAdmin };
