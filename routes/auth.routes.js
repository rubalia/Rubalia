
"use strict";

const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const pool = require("../config/database");
const { generateToken } = require("../utils/token");
const { authenticateToken } = require("../middleware/auth");

const router = express.Router();

const RESET_TOKEN_EXPIRY_MINUTES = 15;
const FRONTEND_URL = process.env.FRONTEND_URL || "";
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL;

const GENERIC_RESET_MESSAGE =
  "If an account exists with this email, a password reset link will be sent.";

// =====================================================
// HELPERS
// =====================================================

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
// CREATE USER SESSION
// =====================================================

async function createUserSession(user, token, req) {
  const decoded = jwt.decode(token);

  if (!decoded || !decoded.sid) {
    throw new Error(
      "Unable to create session: token session ID is missing."
    );
  }

  const deviceInfo = String(
    req.get("user-agent") || ""
  ).slice(0, 500);

  await pool.query(
    `INSERT INTO user_sessions (
       session_id,
       user_id,
       last_activity_at,
       expires_at,
       device_info
     )
     VALUES (
       $1,
       $2,
       NOW(),
       NOW() + INTERVAL '30 days',
       $3
     )
     ON CONFLICT (session_id) DO NOTHING`,
    [
      decoded.sid,
      user.id,
      deviceInfo
    ]
  );
}

function hashResetToken(token) {
  return crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function getFrontendBaseUrl() {
  const firstUrl = FRONTEND_URL
    .split(",")
    .map(value => value.trim())
    .find(Boolean);

  if (!firstUrl) {
    throw new Error("FRONTEND_URL is not configured.");
  }

  const url = new URL(firstUrl);

  if (
    url.protocol !== "https:" &&
    url.hostname !== "localhost"
  ) {
    throw new Error("FRONTEND_URL must use HTTPS.");
  }

  return url.origin;
}

// =====================================================
// SEND PASSWORD RESET EMAIL USING RESEND
// =====================================================

async function sendPasswordResetEmail(
  email,
  fullName,
  resetLink
) {
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) {
    throw new Error(
      "Resend email configuration is missing."
    );
  }

  const safeName = escapeHtml(fullName);
  const safeLink = escapeHtml(resetLink);

  const response = await fetch(
    "https://api.resend.com/emails",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: RESEND_FROM_EMAIL,
        to: [email],
        subject: "Reset Your RUBALIA NETWORK Password",
        html: `
          <!DOCTYPE html>
          <html>
          <body style="margin:0;padding:25px;background:#f7f3f8;font-family:Arial,sans-serif;">
            <div style="max-width:520px;margin:auto;background:#ffffff;border-radius:16px;overflow:hidden;">
              <div style="padding:25px;text-align:center;background:linear-gradient(110deg,#24112f,#4b104f,#a51e43);color:#ffffff;">
                <h1 style="margin:0;font-size:25px;">RUBALIA NETWORK</h1>
                <p style="margin:8px 0 0;color:#f5dca4;letter-spacing:3px;">GROW WITH TRUST</p>
              </div>

              <div style="padding:30px;color:#29243a;">
                <h2 style="margin-top:0;">Reset Your Password</h2>
                <p>Hello ${safeName},</p>
                <p>
                  We received a request to reset your RUBALIA NETWORK
                  account password.
                </p>
                <p style="text-align:center;margin:30px 0;">
                  <a href="${safeLink}"
                     style="display:inline-block;padding:15px 28px;background:#a51e54;color:#ffffff;text-decoration:none;border-radius:9px;font-weight:bold;">
                    RESET PASSWORD
                  </a>
                </p>
                <p>This link expires in 15 minutes and can only be used once.</p>
                <p>If you did not request this, you can safely ignore this email.</p>
                <hr style="border:0;border-top:1px solid #eeeeee;margin:25px 0;">
                <p style="font-size:12px;color:#858196;">
                  RUBALIA NETWORK — Grow With Trust
                </p>
              </div>
            </div>
          </body>
          </html>
        `
      })
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data.message ||
      "Password reset email could not be sent."
    );
  }

  return data;
}

// =====================================================
// POST /api/auth/register
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

  if (!fullName || !email || !password) {
    return res.status(400).json({
      success: false,
      message: "Full name, email and password are required."
    });
  }

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

  if (
    cleanName.length < 2 ||
    cleanName.length > 120
  ) {
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

  let client;

  try {
    client = await pool.connect();

    const passwordHash = await bcrypt.hash(password, 12);

    await client.query("BEGIN");

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
         CASE
           WHEN $4::varchar = 'partner'::varchar
           THEN NOW()
           ELSE NULL
         END
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

    await createUserSession(user, token, req);

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
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error(
          "Registration rollback failed:",
          rollbackError.message
        );
      }
    }

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "An account with this email already exists."
      });
    }

    return next(error);

  } finally {
    if (client) {
      client.release();
    }
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

    await createUserSession(user, token, req);

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
// POST /api/auth/logout
// Revoke current session
// =====================================================

router.post("/logout", authenticateToken, async (req, res, next) => {
  try {
    await pool.query(
      `UPDATE user_sessions
       SET revoked_at = NOW()
       WHERE session_id = $1
         AND user_id = $2
         AND revoked_at IS NULL`,
      [
        req.auth.sid,
        req.auth.id
      ]
    );

    return res.json({
      success: true,
      message: "Logged out successfully."
    });

  } catch (error) {
    return next(error);
  }
});

// =====================================================
// POST /api/auth/forgot-password
// =====================================================

router.post("/forgot-password", async (req, res, next) => {
  try {
    const email = String(req.body?.email || "")
      .trim()
      .toLowerCase();

    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (
      !email ||
      email.length > 255 ||
      !emailPattern.test(email)
    ) {
      return res.status(400).json({
        success: false,
        message: "Please provide a valid email address."
      });
    }

    const userResult = await pool.query(
      `SELECT id, full_name, email
       FROM users
       WHERE email = $1
         AND status = 'active'
       LIMIT 1`,
      [email]
    );

    if (!userResult.rows.length) {
      return res.json({
        success: true,
        message: GENERIC_RESET_MESSAGE
      });
    }

    const user = userResult.rows[0];

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashResetToken(rawToken);

    const resetLink = new URL(
      "/reset-password.html",
      getFrontendBaseUrl()
    );

    resetLink.searchParams.set("token", rawToken);

    await pool.query(
      `DELETE FROM password_reset_tokens
       WHERE user_id = $1
         AND used_at IS NULL`,
      [user.id]
    );

    await pool.query(
      `INSERT INTO password_reset_tokens (
         user_id,
         token_hash,
         expires_at
       )
       VALUES (
         $1,
         $2,
         NOW() + ($3 * INTERVAL '1 minute')
       )`,
      [
        user.id,
        tokenHash,
        RESET_TOKEN_EXPIRY_MINUTES
      ]
    );

    try {
      await sendPasswordResetEmail(
        user.email,
        user.full_name,
        resetLink.toString()
      );

    } catch (emailError) {
      await pool.query(
        `DELETE FROM password_reset_tokens
         WHERE token_hash = $1`,
        [tokenHash]
      );

      console.error(
        "Password reset email failed:",
        emailError.message
      );
    }

    return res.json({
      success: true,
      message: GENERIC_RESET_MESSAGE
    });

  } catch (error) {
    next(error);
  }
});

// =====================================================
// POST /api/auth/reset-password
// =====================================================

router.post("/reset-password", async (req, res, next) => {
  const {
    token,
    password,
    confirmPassword
  } = req.body || {};

  if (
    typeof token !== "string" ||
    !/^[a-f0-9]{64}$/i.test(token)
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid or expired password reset link."
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

  if (password !== confirmPassword) {
    return res.status(400).json({
      success: false,
      message: "Passwords do not match."
    });
  }

  let client;

  try {
    client = await pool.connect();

    const tokenHash = hashResetToken(token);
    const passwordHash = await bcrypt.hash(password, 12);

    await client.query("BEGIN");

    const tokenResult = await client.query(
      `SELECT id, user_id
       FROM password_reset_tokens
       WHERE token_hash = $1
         AND used_at IS NULL
         AND expires_at > NOW()
       FOR UPDATE`,
      [tokenHash]
    );

    if (!tokenResult.rows.length) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        success: false,
        message: "Invalid or expired password reset link."
      });
    }

    const resetRecord = tokenResult.rows[0];

    const updateResult = await client.query(
      `UPDATE users
       SET password_hash = $1,
           updated_at = NOW()
       WHERE id = $2
         AND status = 'active'
       RETURNING id`,
      [
        passwordHash,
        resetRecord.user_id
      ]
    );

    if (!updateResult.rows.length) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        success: false,
        message: "Unable to reset this account password."
      });
    }

    await client.query(
      `UPDATE password_reset_tokens
       SET used_at = NOW()
       WHERE id = $1`,
      [resetRecord.id]
    );

    await client.query(
      `DELETE FROM password_reset_tokens
       WHERE user_id = $1
         AND id <> $2`,
      [
        resetRecord.user_id,
        resetRecord.id
      ]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Password reset successful. Please log in with your new password."
    });

  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error(
          "Password reset rollback failed:",
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
