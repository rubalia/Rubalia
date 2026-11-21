
"use strict";

const express = require("express");
const bcrypt = require("bcryptjs");

const pool = require("../config/database");
const { generateToken } = require("../utils/token");
const { authenticateToken } = require("../middleware/auth");

const router = express.Router();

function makeMemberId(id) {
  return `RUB${String(id).padStart(6, "0")}`;
}

function parseReferralCode(code) {
  const match = String(code || "")
    .trim()
    .toUpperCase()
    .match(/^RUB(\d{6,})$/);

  if (!match) return null;

  try {
    const id = BigInt(match[1]);
    return id > 0n ? id.toString() : null;
  } catch {
    return null;
  }
}

// =====================================================
// POST /api/auth/register
// Customer and Free Partner Registration
// Referral validation + sponsor assignment
// =====================================================

router.post("/register", async (req, res, next) => {
  const {
    fullName,
    email,
    password,
    referralCode
  } = req.body || {};

  const accountType = String(
    req.body?.accountType || "customer"
  ).trim().toLowerCase();

  // Required fields
  if (!fullName || !email || !password) {
    return res.status(400).json({
      success: false,
      message: "Full name, email and password are required."
    });
  }

  // Account type validation
  if (!["customer", "partner"].includes(accountType)) {
    return res.status(400).json({
      success: false,
      message: "Invalid account type."
    });
  }

  const cleanName = String(fullName).trim();
  const cleanEmail = String(email).trim().toLowerCase();
  const cleanReferralCode = String(
    referralCode || ""
  ).trim().toUpperCase();

  if (cleanName.length < 2 || cleanName.length > 120) {
    return res.status(400).json({
      success: false,
      message: "Full name must be between 2 and 120 characters."
    });
  }

  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (
    !emailPattern.test(cleanEmail) ||
    cleanEmail.length > 255
  ) {
    return res.status(400).json({
      success: false,
      message: "Please provide a valid email address."
    });
  }

  if (
    typeof password !== "string" ||
    password.length < 8 ||
    password.length > 72
  ) {
    return res.status(400).json({
      success: false,
      message: "Password must be between 8 and 72 characters."
    });
  }

  // Validate referral code format
  let sponsorId = null;

  if (cleanReferralCode) {
    sponsorId = parseReferralCode(cleanReferralCode);

    if (!sponsorId) {
      return res.status(400).json({
        success: false,
        message: "Invalid referral code format. Example: RUB000001"
      });
    }
  }

  const client = await pool.connect();

  try {
    const passwordHash = await bcrypt.hash(password, 12);

    await client.query("BEGIN");

    // Check sponsor inside the same transaction
    if (sponsorId) {
      const sponsorResult = await client.query(
        `SELECT id, full_name, status
         FROM users
         WHERE id = $1
           AND status = 'active'
         FOR SHARE`,
        [sponsorId]
      );

      if (!sponsorResult.rows.length) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message: "Referral code not found or sponsor is inactive."
        });
      }
    }

    // Create account and save sponsor relationship
    const result = await client.query(
      `INSERT INTO users (
         full_name,
         email,
         password_hash,
         role,
         sponsor_id,
         partner_activated_at
       )
       VALUES (
         $1,
         $2,
         $3,
         $4,
         $5,
         CASE WHEN $4 = 'partner' THEN NOW() ELSE NULL END
       )
       RETURNING
         id,
         full_name,
         email,
         role,
         status,
         sponsor_id,
         partner_activated_at,
         created_at`,
      [
        cleanName,
        cleanEmail,
        passwordHash,
        accountType,
        sponsorId
      ]
    );

    const row = result.rows[0];

    await client.query("COMMIT");

    const user = {
      id: row.id,
      memberId: makeMemberId(row.id),
      full_name: row.full_name,
      email: row.email,
      role: row.role,
      status: row.status,
      sponsor_id: row.sponsor_id,
      partner_activated_at: row.partner_activated_at,
      created_at: row.created_at
    };

    const token = generateToken(user);

    return res.status(201).json({
      success: true,
      message:
        accountType === "partner"
          ? "Free Partner Registration successful."
          : "Registration successful.",
      token,
      user,
      sponsor: sponsorId
        ? {
            memberId: makeMemberId(sponsorId)
          }
        : null
    });

  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("Registration rollback failed:", rollbackError.message);
    }

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "An account with this email already exists."
      });
    }

    return next(error);

  } finally {
    client.release();
  }
});


// =====================================================
// POST /api/auth/login
// =====================================================

router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required."
      });
    }

    const cleanEmail = String(email)
      .trim()
      .toLowerCase();

    const result = await pool.query(
      `SELECT
         id,
         full_name,
         email,
         password_hash,
         role,
         status,
         created_at
       FROM users
       WHERE email = $1`,
      [cleanEmail]
    );

    if (!result.rows.length) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password."
      });
    }

    const userRecord = result.rows[0];

    const passwordMatches = await bcrypt.compare(
      password,
      userRecord.password_hash
    );

    if (!passwordMatches) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password."
      });
    }

    if (userRecord.status !== "active") {
      return res.status(403).json({
        success: false,
        message: "This account is not active."
      });
    }

    const user = {
      id: userRecord.id,
      memberId: makeMemberId(userRecord.id),
      full_name: userRecord.full_name,
      email: userRecord.email,
      role: userRecord.role,
      status: userRecord.status,
      created_at: userRecord.created_at
    };

    const token = generateToken(user);

    return res.json({
      success: true,
      message: "Login successful.",
      token,
      user
    });

  } catch (error) {
    next(error);
  }
});


// =====================================================
// GET /api/auth/me
// =====================================================

router.get("/me", authenticateToken, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT
         id,
         full_name,
         email,
         role,
         status,
         sponsor_id,
         partner_activated_at,
         created_at
       FROM users
       WHERE id = $1`,
      [req.auth.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "User account not found."
      });
    }

    const user = result.rows[0];

    if (user.status !== "active") {
      return res.status(403).json({
        success: false,
        message: "This account is not active."
      });
    }

    return res.json({
      success: true,
      user: {
        ...user,
        memberId: makeMemberId(user.id),
        sponsorMemberId: user.sponsor_id
          ? makeMemberId(user.sponsor_id)
          : null
      }
    });

  } catch (error) {
    next(error);
  }
});

module.exports = router;
