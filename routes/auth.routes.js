const express = require("express");
const bcrypt = require("bcryptjs");

const pool = require("../config/database");
const { generateToken } = require("../utils/token");
const { authenticateToken } = require("../middleware/auth");

const router = express.Router();

// POST /api/auth/register
router.post("/register", async (req, res, next) => {
  try {
    const { fullName, email, password } = req.body;

    if (!fullName || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "Full name, email and password are required."
      });
    }

    const cleanName = String(fullName).trim();
    const cleanEmail = String(email).trim().toLowerCase();

    if (cleanName.length < 2 || cleanName.length > 120) {
      return res.status(400).json({
        success: false,
        message: "Full name must be between 2 and 120 characters."
      });
    }

    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailPattern.test(cleanEmail) || cleanEmail.length > 255) {
      return res.status(400).json({
        success: false,
        message: "Please provide a valid email address."
      });
    }

    if (typeof password !== "string" || password.length < 8 || password.length > 72) {
      return res.status(400).json({
        success: false,
        message: "Password must be between 8 and 72 characters."
      });
    }

    const existingUser = await pool.query(
      "SELECT id FROM users WHERE email = $1",
      [cleanEmail]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "An account with this email already exists."
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO users (full_name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, full_name, email, role, status, created_at`,
      [cleanName, cleanEmail, passwordHash]
    );

    const user = result.rows[0];
    const token = generateToken(user);

    return res.status(201).json({
      success: true,
      message: "Registration successful.",
      token,
      user
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "An account with this email already exists."
      });
    }

    next(error);
  }
});

// POST /api/auth/login
router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required."
      });
    }

    const cleanEmail = String(email).trim().toLowerCase();

    const result = await pool.query(
      `SELECT id, full_name, email, password_hash, role, status, created_at
       FROM users
       WHERE email = $1`,
      [cleanEmail]
    );

    if (result.rows.length === 0) {
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

// GET /api/auth/me
router.get("/me", authenticateToken, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, full_name, email, role, status, created_at
       FROM users
       WHERE id = $1`,
      [req.auth.id]
    );

    if (result.rows.length === 0) {
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
      user
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
