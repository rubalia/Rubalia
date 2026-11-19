
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const pool = require("./config/database");
const { initializeDatabase } = require("./database/init");

const authRoutes = require("./routes/auth.routes");
const profileRoutes = require("./routes/profile.routes");
const productRoutes = require("./routes/product.routes");
const packageRoutes = require("./routes/package.routes");
const orderRoutes = require("./routes/order.routes");
const teamRoutes = require("./routes/team.routes");
const walletRoutes = require("./routes/wallet.routes");
const adminRoutes = require("./routes/admin.routes");
const notificationRoutes = require("./routes/notification.routes");

const {
  notFoundHandler,
  errorHandler
} = require("./middleware/errorHandler");

const app = express();
const PORT = process.env.PORT || 10000;

// Render reverse proxy support
app.set("trust proxy", 1);

const allowedOrigins = (process.env.FRONTEND_URL || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const localOrigins = [
  "http://localhost:3000",
  "http://localhost:5500",
  "http://127.0.0.1:5500"
];

app.use(helmet());

app.use(cors({
  origin(origin, callback) {
    if (!origin) {
      return callback(null, true);
    }

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

// Login Rate Limit
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many login attempts. Please try again after 15 minutes."
  }
});

// Registration Rate Limit
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many registration attempts. Please try again later."
  }
});

// API Health Check
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    return res.json({
      success: true,
      service: "Rubalia Network API",
      database: "connected",
      status: "operational"
    });

  } catch (error) {
    console.error("Health check failed:", error.message);

    return res.status(503).json({
      success: false,
      service: "Rubalia Network API",
      database: "unavailable",
      status: "degraded"
    });
  }
});

// Authentication Routes
// Login and registration have separate limits.
app.use("/api/auth/login", loginLimiter);
app.use("/api/auth/register", registerLimiter);
app.use("/api/auth", authRoutes);

// Other API Routes
app.use("/api/profile", profileRoutes);
app.use("/api/products", productRoutes);
app.use("/api/packages", packageRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/team", teamRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/notifications", notificationRoutes);

// 404 Handler
app.use(notFoundHandler);

// Global Error Handler
app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  if (error.message === "Origin not allowed by CORS") {
    return res.status(403).json({
      success: false,
      message: "Origin not allowed."
    });
  }

  return errorHandler(error, req, res, next);
});

// Start Server
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
