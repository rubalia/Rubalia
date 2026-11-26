
"use strict";

const jwt = require("jsonwebtoken");
const pool = require("../config/database");

const JWT_SECRET = process.env.JWT_SECRET;

// Maximum inactivity: 24 hours
const INACTIVITY_LIMIT_HOURS = 24;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error(
    "JWT_SECRET must be at least 32 characters."
  );
}

// =====================================================
// AUTHENTICATION MIDDLEWARE
// RUBALIA NETWORK
// =====================================================

async function authenticateToken(req, res, next) {
  const header = req.headers.authorization || "";
  const parts = header.split(" ");

  if (parts.length !== 2 || parts[0] !== "Bearer") {
    return res.status(401).json({
      success: false,
      code: "AUTH_REQUIRED",
      message: "Authentication required."
    });
  }

  try {
    // Verify JWT
    const decoded = jwt.verify(parts[1], JWT_SECRET, {
      issuer: "rubalia-network"
    });

    // Validate required token information
    if (
      !decoded.id ||
      !decoded.email ||
      !decoded.role ||
      !decoded.sid
    ) {
      return res.status(401).json({
        success: false,
        code: "INVALID_TOKEN",
        message: "Invalid authentication token."
      });
    }

    // Check and update the session activity
    const sessionResult = await pool.query(
      `UPDATE user_sessions
       SET
         last_activity_at = NOW(),
         expires_at = NOW() + INTERVAL '30 days'
       WHERE session_id = $1
         AND user_id = $2
         AND revoked_at IS NULL
         AND expires_at > NOW()
         AND last_activity_at >
             NOW() - ($3 * INTERVAL '1 hour')
       RETURNING
         id,
         user_id,
         session_id,
         last_activity_at`,
      [
        decoded.sid,
        decoded.id,
        INACTIVITY_LIMIT_HOURS
      ]
    );

    // Session missing, revoked, expired or inactive
    if (!sessionResult.rows.length) {
      return res.status(401).json({
        success: false,
        code: "SESSION_EXPIRED",
        message: "Your session has expired due to inactivity. Please log in again."
      });
    }

    // Attach authenticated user and session
    req.auth = decoded;

    req.session = sessionResult.rows[0];

    next();

  } catch (error) {
    if (
      error.name === "TokenExpiredError" ||
      error.name === "JsonWebTokenError" ||
      error.name === "NotBeforeError"
    ) {
      return res.status(401).json({
        success: false,
        code: "TOKEN_EXPIRED",
        message: "Your login session has expired. Please log in again."
      });
    }

    // Database or unexpected errors
    return next(error);
  }
}

module.exports = {
  authenticateToken
};
