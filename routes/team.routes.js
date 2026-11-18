const express = require("express");

const pool = require("../config/database");
const { authenticateToken } = require("../middleware/auth");

const router = express.Router();

// GET /api/team
// Show the logged-in user's team up to 10 levels.
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
        created_at,
        level
      FROM team_tree
      ORDER BY level ASC, created_at ASC`,
      [req.auth.id]
    );

    const members = result.rows;

    const levelSummary = [];

    for (let level = 1; level <= 10; level++) {
      const count = members.filter(
        member => Number(member.level) === level
      ).length;

      levelSummary.push({
        level,
        members: count
      });
    }

    return res.json({
      success: true,
      totalMembers: members.length,
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
        created_at
       FROM users
       WHERE sponsor_id = $1
       ORDER BY created_at DESC`,
      [req.auth.id]
    );

    return res.json({
      success: true,
      totalMembers: result.rows.length,
      members: result.rows
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
