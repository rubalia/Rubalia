"use strict";

const express = require("express");
const pool = require("../config/database");
const { authenticateToken } = require("../middleware/auth");

const router = express.Router();

const FRONTEND_URL = (
  process.env.FRONTEND_URL ||
  "https://rubalia.github.io/Rubalia"
).split(",")[0].trim().replace(/\/+$/, "");

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
    if (id <= 0n) return null;
    return id.toString();
  } catch {
    return null;
  }
}

// GET /api/referral/me
// Logged-in member's referral details.
router.get("/me", authenticateToken, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, full_name, email, sponsor_id, status
       FROM users
       WHERE id = $1`,
      [req.auth.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Member not found."
      });
    }

    const member = result.rows[0];
    const memberId = makeMemberId(member.id);
    const referralUrl =
      `${FRONTEND_URL}/register.html?ref=${encodeURIComponent(memberId)}`;

    return res.json({
      success: true,
      member: {
        memberId,
        fullName: member.full_name,
        email: member.email,
        status: member.status,
        sponsorId: member.sponsor_id
          ? makeMemberId(member.sponsor_id)
          : null
      },
      referralCode: memberId,
      referralLink: referralUrl
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/referral/verify/:code
// Public endpoint for checking a referral code during registration.
router.get("/verify/:code", async (req, res, next) => {
  try {
    const sponsorId = parseReferralCode(req.params.code);

    if (!sponsorId) {
      return res.status(400).json({
        success: false,
        valid: false,
        message: "Invalid referral code format."
      });
    }

    const result = await pool.query(
      `SELECT id, full_name
       FROM users
       WHERE id = $1
         AND status = 'active'`,
      [sponsorId]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: true,
        valid: false,
        message: "Referral code not found or inactive."
      });
    }

    const sponsor = result.rows[0];

    return res.json({
      success: true,
      valid: true,
      sponsor: {
        memberId: makeMemberId(sponsor.id),
        name: sponsor.full_name
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/referral/stats
// Logged-in member's direct and 10-level referral statistics.
router.get("/stats", authenticateToken, async (req, res, next) => {
  try {
    const result = await pool.query(
      `WITH RECURSIVE referral_tree AS (
        SELECT
          id,
          sponsor_id,
          1 AS level,
          ARRAY[id]::BIGINT[] AS visited_ids
        FROM users
        WHERE sponsor_id = $1

        UNION ALL

        SELECT
          u.id,
          u.sponsor_id,
          t.level + 1,
          t.visited_ids || u.id
        FROM users u
        INNER JOIN referral_tree t
          ON u.sponsor_id = t.id
        WHERE t.level < 10
          AND NOT u.id = ANY(t.visited_ids)
      )
      SELECT
        level,
        COUNT(*)::INTEGER AS members
      FROM referral_tree
      GROUP BY level
      ORDER BY level`,
      [req.auth.id]
    );

    const levels = Array.from({ length: 10 }, (_, index) => {
      const level = index + 1;
      const found = result.rows.find(
        row => Number(row.level) === level
      );

      return {
        level,
        members: found ? Number(found.members) : 0
      };
    });

    const totalMembers = levels.reduce(
      (sum, item) => sum + item.members,
      0
    );

    return res.json({
      success: true,
      directMembers: levels[0].members,
      totalMembers,
      levels
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/referral/direct
// Logged-in member's direct referrals.
router.get("/direct", authenticateToken, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT
        id,
        full_name,
        email,
        status,
        created_at
       FROM users
       WHERE sponsor_id = $1
       ORDER BY created_at DESC`,
      [req.auth.id]
    );

    const members = result.rows.map(member => ({
      memberId: makeMemberId(member.id),
      fullName: member.full_name,
      email: member.email,
      status: member.status,
      joinedAt: member.created_at
    }));

    return res.json({
      success: true,
      totalMembers: members.length,
      members
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
