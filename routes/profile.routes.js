
"use strict";

const express = require("express");
const pool = require("../config/database");
const { authenticateToken } = require("../middleware/auth");

const router = express.Router();

// ============================================
// GET MEMBER PROFILE
// GET /api/profile
// ============================================

router.get("/", authenticateToken, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT
         id,
         username,
         full_name,
         phone,
         email,
         role,
         status,
         avatar_url,
         created_at,
         updated_at
       FROM users
       WHERE id = $1`,
      [req.auth.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Profile not found."
      });
    }

    return res.json({
      success: true,
      profile: result.rows[0]
    });

  } catch (error) {
    next(error);
  }
});

// ============================================
// UPDATE MEMBER PROFILE
// PUT /api/profile
// ============================================

router.put("/", authenticateToken, async (req, res, next) => {
  try {
    const { username, fullName, phone } = req.body || {};

    // Validate username
    if (typeof username !== "string") {
      return res.status(400).json({
        success: false,
        message: "Username is required."
      });
    }

    const cleanUsername = username.trim().toLowerCase();

    if (
      cleanUsername.length < 3 ||
      cleanUsername.length > 30
    ) {
      return res.status(400).json({
        success: false,
        message: "Username must be between 3 and 30 characters."
      });
    }

    if (!/^[a-z][a-z0-9_.]*$/.test(cleanUsername)) {
      return res.status(400).json({
        success: false,
        message: "Username must start with a letter and may contain letters, numbers, dots and underscores."
      });
    }

    // Validate full name
    if (typeof fullName !== "string") {
      return res.status(400).json({
        success: false,
        message: "Full name is required."
      });
    }

    const cleanName = fullName.trim();

    if (cleanName.length < 2 || cleanName.length > 120) {
      return res.status(400).json({
        success: false,
        message: "Full name must be between 2 and 120 characters."
      });
    }

    // Validate phone number
    let cleanPhone = null;

    if (phone !== undefined && phone !== null) {
      if (typeof phone !== "string") {
        return res.status(400).json({
          success: false,
          message: "Invalid phone number."
        });
      }

      cleanPhone = phone.trim().replace(/[\s()-]/g, "");

      if (cleanPhone !== "") {
        if (!/^\+?[0-9]{10,15}$/.test(cleanPhone)) {
          return res.status(400).json({
            success: false,
            message: "Enter a valid phone number with 10 to 15 digits."
          });
        }
      } else {
        cleanPhone = null;
      }
    }

    // Check username availability
    const existing = await pool.query(
      `SELECT id
       FROM users
       WHERE LOWER(username) = LOWER($1)
         AND id <> $2
       LIMIT 1`,
      [cleanUsername, req.auth.id]
    );

    if (existing.rows.length) {
      return res.status(409).json({
        success: false,
        message: "This username is already taken. Please choose another."
      });
    }

    // Update profile
    const result = await pool.query(
      `UPDATE users
       SET username = $1,
           full_name = $2,
           phone = $3,
           updated_at = NOW()
       WHERE id = $4
       RETURNING
         id,
         username,
         full_name,
         phone,
         email,
         role,
         status,
         avatar_url,
         created_at,
         updated_at`,
      [
        cleanUsername,
        cleanName,
        cleanPhone,
        req.auth.id
      ]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Profile not found."
      });
    }

    return res.json({
      success: true,
      message: "Profile updated successfully.",
      profile: result.rows[0]
    });

  } catch (error) {

    // Handles concurrent username registration attempts
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "This username is already taken."
      });
    }

    next(error);
  }
});

module.exports = router;
