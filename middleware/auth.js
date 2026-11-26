
"use strict";

const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET;

// 24 hours inactivity limit
const INACTIVITY_LIMIT = 24 * 60 * 60 * 1000;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error(
    "JWT_SECRET must be at least 32 characters."
  );
}

function authenticateToken(req, res, next) {
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
    const decoded = jwt.verify(parts[1], JWT_SECRET, {
      issuer: "rubalia-network"
    });

    // Check required token information
    if (!decoded.id || !decoded.email || !decoded.role) {
      return res.status(401).json({
        success: false,
        code: "INVALID_TOKEN",
        message: "Invalid authentication token."
      });
    }

    /*
      Inactivity validation will use the
      lastActivityAt timestamp added by
      the session system in the next step.

      Until then, do not assume that token
      issue time represents last activity.
    */

    req.auth = decoded;
    next();

  } catch (error) {
    return res.status(401).json({
      success: false,
      code: "TOKEN_EXPIRED",
      message: "Your session has expired. Please log in again."
    });
  }
}

module.exports = {
  authenticateToken
};
