
"use strict";

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const pool = require("./config/database");
const { initializeDatabase } = require("./database/init");

const { runPartnerMigration } = require("./database/partner-migration");
const { runCommissionSafetyMigration } = require("./database/commission-safety-migration");
const { runProductCostMigration } = require("./database/product-cost-migration");
const { runProductCategoryMigration } = require("./database/product-category-migration");
const { runWalletMigration } = require("./database/wallet-migration");
const { runSupportMigration } = require("./database/support-migration");
const { runSettingsMigration } = require("./database/settings-migration");

// Password Reset Migration
const {
  runPasswordResetMigration
} = require("./database/password-reset-migration");

// Profile Image Migration
const {
  runProfileImageMigration
} = require("./database/profile-image-migration");

// Routes
const authRoutes = require("./routes/auth.routes");
const profileRoutes = require("./routes/profile.routes");
const productRoutes = require("./routes/product.routes");
const packageRoutes = require("./routes/package.routes");
const orderRoutes = require("./routes/order.routes");
const teamRoutes = require("./routes/team.routes");
const walletRoutes = require("./routes/wallet.routes");
const adminRoutes = require("./routes/admin.routes");
const notificationRoutes = require("./routes/notification.routes");
const uploadRoutes = require("./routes/upload.routes");
const paymentRoutes = require("./routes/payment.routes");
const referralRoutes = require("./routes/referral.routes");
const commissionRoutes = require("./routes/commission.routes");
const refundRoutes = require("./routes/refund.routes");
const supportRoutes = require("./routes/support.routes");
const settingsRoutes = require("./routes/settings.routes");

// Commission Worker
const {
  startCommissionWorker,
  stopCommissionWorker
} = require("./workers/commission.worker");

// Error Handlers
const {
  notFoundHandler,
  errorHandler
} = require("./middleware/errorHandler");

const app = express();
const PORT = process.env.PORT || 10000;

app.set("trust proxy", 1);

// =====================================================
// CORS CONFIGURATION
// =====================================================

const allowedOrigins = (process.env.FRONTEND_URL || "")
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);

const capacitorOrigins = [
  "https://localhost",
  "capacitor://localhost"
];

const localOrigins = [
  "http://localhost:3000",
  "http://localhost:5500",
  "http://127.0.0.1:5500"
];

app.use(helmet());

app.use(cors({
  origin(origin, callback) {
    if (
      !origin ||
      allowedOrigins.includes(origin) ||
      capacitorOrigins.includes(origin) ||
      localOrigins.includes(origin)
    ) {
      return callback(null, true);
    }

    console.warn("CORS blocked origin:", origin);

    return callback(
      new Error("Origin not allowed by CORS")
    );
  }
}));

app.use(express.json({ limit: "1mb" }));

// =====================================================
// RATE LIMITERS
// =====================================================

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

const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many password reset requests. Please try again later."
  }
});

const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many password reset attempts. Please try again later."
  }
});

// =====================================================
// HEALTH CHECK
// =====================================================

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

// =====================================================
// PUBLIC ADMIN ANNOUNCEMENT API
// =====================================================

app.get("/api/public/admin-message", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        text,
        created_at,
        updated_at
      FROM admin_messages
      WHERE active = TRUE
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `);

    return res.json({
      success: true,
      message: result.rows[0] || null
    });

  } catch (error) {
    console.error(
      "Public admin message error:",
      error.message
    );

    return res.status(500).json({
      success: false,
      message: null
    });
  }
});

// =====================================================
// AUTHENTICATION ROUTES
// =====================================================

app.use("/api/auth/login", loginLimiter);
app.use("/api/auth/register", registerLimiter);

app.use(
  "/api/auth/forgot-password",
  forgotPasswordLimiter
);

app.use(
  "/api/auth/reset-password",
  resetPasswordLimiter
);

app.use("/api/auth", authRoutes);

// =====================================================
// EXISTING API ROUTES
// =====================================================

app.use("/api/profile", profileRoutes);
app.use("/api/products", productRoutes);
app.use("/api/packages", packageRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/team", teamRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/referral", referralRoutes);
app.use("/api/commission", commissionRoutes);
app.use("/api/refunds", refundRoutes);
app.use("/api/payment", paymentRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/support", supportRoutes);

// Member Settings API
app.use("/api/settings", settingsRoutes);

// =====================================================
// ERROR HANDLING
// =====================================================

app.use(notFoundHandler);

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

// =====================================================
// START SERVER
// =====================================================

async function startServer() {
  try {
    await initializeDatabase();
    console.log("Database initialization completed.");

    await runPartnerMigration();
    console.log("Partner migration completed.");

    await runCommissionSafetyMigration();
    console.log("Commission safety migration completed.");

    await runProductCostMigration();
    console.log("Product cost migration completed.");

    await runProductCategoryMigration();
    console.log("Product category migration completed.");

    await runWalletMigration();
    console.log("Wallet migration completed.");

    await runSupportMigration();
    console.log("Support migration completed.");

    await runSettingsMigration();
    console.log("Settings migration completed.");

    // Password Reset Database Migration
    await runPasswordResetMigration();
    console.log("Password reset migration completed.");

    // Profile Image Database Migration
    await runProfileImageMigration();
    console.log("Profile image migration completed.");

    // Start Commission Worker
    startCommissionWorker(pool);
    console.log("Commission worker started.");

    const server = app.listen(PORT, "0.0.0.0", () => {
      console.log(`Rubalia API running on port ${PORT}`);
      console.log("Cloudinary upload route registered.");
      console.log("Member profile photo upload API enabled.");
      console.log("Payment route registered.");
      console.log("Referral route registered.");
      console.log("Commission route registered.");
      console.log("Refund route registered.");
      console.log("Product cost management enabled.");
      console.log("Package cost management enabled.");
      console.log("Product category management enabled.");
      console.log("Wallet deposit and withdrawal management enabled.");
      console.log("Support ticket system enabled.");
      console.log("Member settings API enabled.");
      console.log("Password reset system enabled.");
      console.log("Public admin announcement API enabled.");
      console.log("Capacitor WebView CORS origins enabled.");
    });

    // =================================================
    // GRACEFUL SHUTDOWN
    // =================================================

    let shuttingDown = false;

    async function shutdown(signal) {
      if (shuttingDown) {
        return;
      }

      shuttingDown = true;

      console.log(`${signal} received. Shutting down...`);

      try {
        await stopCommissionWorker();

        server.close(async () => {
          try {
            await pool.end();

            console.log("Rubalia API shutdown completed.");

            process.exit(0);

          } catch (error) {
            console.error(
              "Database shutdown failed:",
              error.message
            );

            process.exit(1);
          }
        });

      } catch (error) {
        console.error("Shutdown failed:", error.message);
        process.exit(1);
      }
    }

    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));

  } catch (error) {
    console.error("Startup failed:", error.message);
    process.exit(1);
  }
}

startServer();
