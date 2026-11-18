require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 10000;

const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET;

if (!DATABASE_URL) {
  console.error("DATABASE_URL environment variable is required.");
  process.exit(1);
}

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error("JWT_SECRET must be set and at least 32 characters long.");
  process.exit(1);
}

// PostgreSQL connection
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true"
    ? { rejectUnauthorized: false }
    : undefined,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL error:", error.message);
});

// Allowed frontend origins
const allowedOrigins = (process.env.FRONTEND_URL || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(helmet());

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);

    const localOrigins = [
      "http://localhost:3000",
      "http://localhost:5500",
      "http://127.0.0.1:5500"
    ];

    if (
      allowedOrigins.includes(origin) ||
      localOrigins.includes(origin)
    ) {
      return callback(null, true);
    }

    return callback(new Error("Origin not allowed by CORS"));
  }
}));

app.use(express.json({ limit: "1mb" }));

// Rate limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many attempts. Please try again later."
  }
});

// Database initialization
async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      full_name VARCHAR(120) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role VARCHAR(30) NOT NULL DEFAULT 'customer',
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_users_email
    ON users(email);
  `);

  console.log("Database tables initialized.");
}

// Create JWT
function createToken(user) {
  return jwt.sign(
    {
      sub: String(user.id),
      email: user.email
    },
    JWT_SECRET,
    {
      expiresIn: "1d",
      issuer: "rubalia-network"
    }
  );
}

// Authentication middleware
function authenticateToken(req, res, next) {
  const header = req.headers.authorization || "";
  const parts = header.split(" ");

  if (parts.length !== 2 || parts[0] !== "Bearer") {
    return res.status(401).json({
      success: false,
      message: "Authentication required."
    });
  }

  try {
    const decoded = jwt.verify(parts[1], JWT_SECRET, {
      issuer: "rubalia-network"
    });

    req.auth = decoded;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token."
    });
  }
}

// Health check
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      success: true,
      service: "Rubalia Network API",
      database: "connected",
      status: "operational"
    });
  } catch (error) {
    res.status(503).json({
      success: false,
      service: "Rubalia Network API",
      database: "unavailable",
      status: "degraded"
    });
  }
});

// Register
app.post(
  "/api/auth/register",
  authLimiter,
  async (req, res) => {
    try {
      const fullName = String(req.body.fullName || "").trim();
      const email = String(req.body.email || "")
        .trim()
        .toLowerCase();
      const password = String(req.body.password || "");

      if (fullName.length < 2 || fullName.length > 120) {
        return res.status(400).json({
          success: false,
          message: "Enter a valid full name."
        });
      }

      const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

      if (!emailPattern.test(email) || email.length > 255) {
        return res.status(400).json({
          success: false,
          message: "Enter a valid email address."
        });
      }

      if (password.length < 8 || password.length > 72) {
        return res.status(400).json({
          success: false,
          message: "Password must contain 8 to 72 characters."
        });
      }

      const passwordHash = await bcrypt.hash(password, 12);

      const result = await pool.query(
        `INSERT INTO users
          (full_name, email, password_hash)
         VALUES ($1, $2, $3)
         RETURNING id, full_name, email, role, status, created_at`,
        [fullName, email, passwordHash]
      );

      const user = result.rows[0];
      const token = createToken(user);

      return res.status(201).json({
        success: true,
        message: "Account created successfully.",
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

      console.error("Registration error:", error.message);

      return res.status(500).json({
        success: false,
        message: "Unable to create account."
      });
    }
  }
);

// Login
app.post(
  "/api/auth/login",
  authLimiter,
  async (req, res) => {
    try {
      const email = String(req.body.email || "")
        .trim()
        .toLowerCase();
      const password = String(req.body.password || "");

      if (!email || !password) {
        return res.status(400).json({
          success: false,
          message: "Email and password are required."
        });
      }

      const result = await pool.query(
        `SELECT id, full_name, email, password_hash, role, status
         FROM users
         WHERE email = $1
         LIMIT 1`,
        [email]
      );

      const user = result.rows[0];

      if (!user) {
        return res.status(401).json({
          success: false,
          message: "Invalid email or password."
        });
      }

      const passwordMatches = await bcrypt.compare(
        password,
        user.password_hash
      );

      if (!passwordMatches || user.status !== "active") {
        return res.status(401).json({
          success: false,
          message: "Invalid email or password."
        });
      }

      const token = createToken(user);

      return res.json({
        success: true,
        message: "Login successful.",
        token,
        user: {
          id: user.id,
          full_name: user.full_name,
          email: user.email,
          role: user.role,
          status: user.status
        }
      });

    } catch (error) {
      console.error("Login error:", error.message);

      return res.status(500).json({
        success: false,
        message: "Unable to login."
      });
    }
  }
);

// Current authenticated user
app.get("/api/auth/me", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, full_name, email, role, status, created_at
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [req.auth.sub]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "User not found."
      });
    }

    return res.json({
      success: true,
      user: result.rows[0]
    });

  } catch (error) {
    console.error("Profile error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to load user profile."
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "API endpoint not found."
  });
});

// General error handler
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

  if (error.message === "Origin not allowed by CORS") {
    return res.status(403).json({
      success: false,
      message: "Origin not allowed."
    });
  }

  console.error("Server error:", error.message);

  res.status(500).json({
    success: false,
    message: "Internal server error."
  });
});

// Start server after database initialization
async function startServer() {
  try {
    await initializeDatabase();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Rubalia API running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Startup failed:", error.message);
    process.exit(1);
  }
}

startServer();
