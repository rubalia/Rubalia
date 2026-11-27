
"use strict";

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const pool = require("./config/database");
const { initializeDatabase } = require("./database/init");

// Existing Database Migrations
const { runPartnerMigration } = require("./database/partner-migration");
const { runCommissionSafetyMigration } = require("./database/commission-safety-migration");
const { runProductCostMigration } = require("./database/product-cost-migration");
const { runProductCategoryMigration } = require("./database/product-category-migration");
const { runWalletMigration } = require("./database/wallet-migration");
const { runSupportMigration } = require("./database/support-migration");
const { runSettingsMigration } = require("./database/settings-migration");

const {
  runPasswordResetMigration
} = require("./database/password-reset-migration");

const {
  runProfileImageMigration
} = require("./database/profile-image-migration");

const {
  runMonthlyFinancialReportMigration
} = require("./database/monthly-financial-report-migration");

const {
  runModeratorMigration
} = require("./database/moderator-migration");

const {
  runPushNotificationMigration
} = require("./database/push-notification-migration");

const {
  runSessionMigration
} = require("./database/session-migration");

// NEW: API Management Migration
const {
  runApiManagementMigration
} = require("./database/api-management-migration");

// Routes
const authRoutes = require("./routes/auth.routes");
const profileRoutes = require("./routes/profile.routes");
const productRoutes = require("./routes/product.routes");
const packageRoutes = require("./routes/package.routes");
const orderRoutes = require("./routes/order.routes");
const teamRoutes = require("./routes/team.routes");
const walletRoutes = require("./routes/wallet.routes");
const adminRoutes = require("./routes/admin.routes");
const moderatorRoutes = require("./routes/moderator.routes");
const notificationRoutes = require("./routes/notification.routes");
const pushRoutes = require("./routes/push.routes");
const uploadRoutes = require("./routes/upload.routes");
const paymentRoutes = require("./routes/payment.routes");
const referralRoutes = require("./routes/referral.routes");
const commissionRoutes = require("./routes/commission.routes");
const refundRoutes = require("./routes/refund.routes");
const supportRoutes = require("./routes/support.routes");
const settingsRoutes = require("./routes/settings.routes");

const financialReportRoutes = require("./routes/financial-report.routes");

// NEW: API Management Route
const apiManagementRoutes = require("./routes/api-management.routes");

// NEW: API Request Logger
const apiLogger = require("./middleware/apiLogger");

// Commission Worker
const {
  startCommissionWorker,
  stopCommissionWorker
} = require("./workers/commission.worker");

// Monthly Financial Report Worker
const {
  startMonthlyFinancialReportWorker,
  stopMonthlyFinancialReportWorker
} = require("./workers/monthly-financial-report.worker");

// Error Handlers
const {
  notFoundHandler,
  errorHandler
} = require("./middleware/errorHandler");

// =====================================================
// EXPRESS APP
// =====================================================

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
// API REQUEST LOGGER
// =====================================================

// Records API request method, endpoint, status and response time.
// Does not store request bodies or query-string values.
app.use(apiLogger);

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

// =====================================================
// API MANAGEMENT ROUTE
// =====================================================

// Keep this before the general admin router.
app.use(
  "/api/admin/api-management",
  apiManagementRoutes
);

// Existing Admin API
app.use("/api/admin", adminRoutes);

app.use("/api/moderators", moderatorRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/push", pushRoutes);

app.use("/api/referral", referralRoutes);
app.use("/api/commission", commissionRoutes);
app.use("/api/refunds", refundRoutes);
app.use("/api/payment", paymentRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/support", supportRoutes);
app.use("/api/settings", settingsRoutes);

// =====================================================
// MONTHLY FINANCIAL REPORT API
// =====================================================

app.use(
  "/api/financial-reports",
  financialReportRoutes
);

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

    // -----------------------------------------------
    // DATABASE INITIALIZATION
    // -----------------------------------------------

    await initializeDatabase();
    console.log("Database initialization completed.");

    // -----------------------------------------------
    // EXISTING MIGRATIONS
    // -----------------------------------------------

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

    await runPasswordResetMigration();
    console.log("Password reset migration completed.");

    await runProfileImageMigration();
    console.log("Profile image migration completed.");

    await runMonthlyFinancialReportMigration();
    console.log("Monthly financial report migration completed.");

    await runModeratorMigration();
    console.log("Moderator migration completed.");

    await runPushNotificationMigration();
    console.log("Push notification migration completed.");

    await runSessionMigration();
    console.log("User session migration completed.");

    // -----------------------------------------------
    // NEW: API MANAGEMENT DATABASE MIGRATION
    // -----------------------------------------------

    await runApiManagementMigration();
    console.log("API management migration completed.");

    // -----------------------------------------------
    // START COMMISSION WORKER
    // -----------------------------------------------

    startCommissionWorker(pool);
    console.log("Commission worker started.");

    // -----------------------------------------------
    // START MONTHLY FINANCIAL REPORT WORKER
    // -----------------------------------------------

    startMonthlyFinancialReportWorker(pool);
    console.log("Monthly financial report worker started.");

    // -----------------------------------------------
    // START EXPRESS SERVER
    // -----------------------------------------------

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
      console.log("Monthly financial reports API enabled.");
      console.log("Monthly financial report worker enabled.");
      console.log("Moderator management API enabled.");
      console.log("Moderator database migration enabled.");
      console.log("Capacitor WebView CORS origins enabled.");

      console.log("Firebase push notification routes registered.");
      console.log("Push device token registration API enabled.");
      console.log("Admin push broadcast API enabled.");

      console.log("User session database enabled.");

      // NEW API MANAGEMENT
      console.log("API request logger enabled.");
      console.log("API management database enabled.");
      console.log("Admin API management routes registered.");
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
        await stopMonthlyFinancialReportWorker();

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

// =====================================================
// RUN SERVER
// =====================================================

startServer();
