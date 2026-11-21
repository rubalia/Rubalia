
"use strict";

const express = require("express");
const pool = require("../config/database");
const { authenticateToken } = require("../middleware/auth");

const router = express.Router();

// Generate Rubalia Member ID
function makeMemberId(id) {
  return `RUB${String(id).padStart(6, "0")}`;
}

// Format team member response
function formatMember(member) {
  return {
    id: member.id,
    memberId: makeMemberId(member.id),

    fullName: member.full_name,
    email: member.email,

    sponsorId: member.sponsor_id,
    sponsorMemberId: member.sponsor_id
      ? makeMemberId(member.sponsor_id)
      : null,

    role: member.role,
    status: member.status,

    isPartner:
      member.role === "partner" &&
      Boolean(member.partner_activated_at),

    partnerActivatedAt: member.partner_activated_at || null,

    joinedAt: member.created_at,
    level: Number(member.level || 1)
  };
}

// GET /api/team
// Show logged-in user's team up to 10 levels.
router.get("/", authenticateToken, async (req, res, next) => {
  try {
    const result = await pool.query(
      `WITH RECURSIVE team_tree AS (
        SELECT
          id,
          full_name,
          email,
          sponsor_id,
          role,
          status,
          partner_activated_at,
          created_at,
          1 AS level,
          ARRAY[id]::BIGINT[] AS visited_ids
        FROM users
        WHERE sponsor_id = $1

        UNION ALL

        SELECT
          u.id,
          u.full_name,
          u.email,
          u.sponsor_id,
          u.role,
          u.status,
          u.partner_activated_at,
          u.created_at,
          t.level + 1,
          t.visited_ids || u.id
        FROM users u
        INNER JOIN team_tree t
          ON u.sponsor_id = t.id
        WHERE t.level < 10
          AND NOT u.id = ANY(t.visited_ids)
      )
      SELECT
        id,
        full_name,
        email,
        sponsor_id,
        role,
        status,
        partner_activated_at,
        created_at,
        level
      FROM team_tree
      ORDER BY level ASC, created_at ASC`,
      [req.auth.id]
    );

    const members = result.rows.map(formatMember);

    // Build 10-level summary
    const levelSummary = Array.from(
      { length: 10 },
      (_, index) => {
        const level = index + 1;

        const count = members.filter(
          member => member.level === level
        ).length;

        return {
          level,
          members: count
        };
      }
    );

    const totalMembers = members.length;
    const directMembers = levelSummary[0].members;

    const totalPartners = members.filter(
      member => member.isPartner
    ).length;

    return res.json({
      success: true,

      totalMembers,
      directMembers,
      totalPartners,

      levelSummary,
      members
    });

  } catch (error) {
    next(error);
  }
});

// GET /api/team/direct
// Show only direct referrals (Level 1).
router.get("/direct", authenticateToken, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT
        id,
        full_name,
        email,
        sponsor_id,
        role,
        status,
        partner_activated_at,
        created_at
       FROM users
       WHERE sponsor_id = $1
       ORDER BY created_at DESC`,
      [req.auth.id]
    );

    const members = result.rows.map(member =>
      formatMember({
        ...member,
        level: 1
      })
    );

    const totalPartners = members.filter(
      member => member.isPartner
    ).length;

    return res.json({
      success: true,
      totalMembers: members.length,
      totalPartners,
      members
    });

  } catch (error) {
    next(error);
  }
});

module.exports = router;
