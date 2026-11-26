
"use strict";

const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error(
    "JWT_SECRET must be at least 32 characters."
  );
}

/*
=====================================================
RUBALIA NETWORK - TOKEN SYSTEM
=====================================================

- JWT lifetime: 30 days
- Unique session ID for each login
- 24-hour inactivity will be enforced
  by the authentication middleware.
- Token verification uses the existing issuer.

IMPORTANT:
The 24-hour inactivity check will be
implemented in the next authentication files.
*/

function generateToken(user) {
  if (!user || !user.id || !user.email || !user.role) {
    throw new Error(
      "Valid user information is required to generate token."
    );
  }

  const sessionId = crypto.randomUUID();

  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      sid: sessionId
    },
    JWT_SECRET,
    {
      expiresIn: "30d",
      issuer: "rubalia-network",
      subject: String(user.id),
      jwtid: sessionId
    }
  );
}

module.exports = {
  generateToken
};
