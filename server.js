
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const pool = require("./config/database");

const { initializeDatabase } = require("./database/init");

const {
  runPartnerMigration
} = require("./database/partner-migration");

const {
  runCommissionSafetyMigration
} = require("./database/commission-safety-migration");

const {
  runProductCostMigration
} = require("./database/product-cost-migration");

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

// =====================================================
// RENDER PROXY
// =====================================================

app.set("trust proxy", 1);

// =====================================================
// CORS CONFIGURATION
// =====================================================

const allowedOrigins = (process.env.FRONTEND_URL || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const localOrigins = [
  "http://localhost:3000",
  "http://localhost:5500",
  "http://127.0.0.1:5500"
];

// =====================================================
// SECURITY
// =====================================================

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

// =====================================================
// JSON BODY
// =====================================================

app.use(express.json({ limit: "1mb" }));

// =====================================================
// LOGIN RATE LIMIT
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

// =====================================================
// REGISTRATION RATE LIMIT
// =====================================================

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

// =====================================================
// API HEALTH CHECK
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
// AUTHENTICATION ROUTES
// =====================================================

app.use("/api/auth/login", loginLimiter);
app.use("/api/auth/register", registerLimiter);
app.use("/api/auth", authRoutes);

// =====================================================
// OTHER API ROUTES
// =====================================================

app.use("/api/profile", profileRoutes);
app.use("/api/products", productRoutes);
app.use("/api/packages", packageRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/team", teamRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/notifications", notificationRoutes);

// =====================================================
// REFERRAL ROUTES
// =====================================================

app.use("/api/referral", referralRoutes);

// =====================================================
// COMMISSION ROUTES
// =====================================================

app.use("/api/commission", commissionRoutes);

// =====================================================
// REFUND ROUTES
// =====================================================

app.use("/api/refunds", refundRoutes);

// =====================================================
// PAYMENT ROUTES
// =====================================================

app.use("/api/payment", paymentRoutes);

// =====================================================
// IMAGE UPLOAD ROUTES
// =====================================================

app.use("/api/upload", uploadRoutes);

// =====================================================
// 404 HANDLER
// =====================================================

app.use(notFoundHandler);

// =====================================================
// GLOBAL ERROR HANDLER
// =====================================================

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
    // 1. Initialize database
    await initializeDatabase();

    console.log("Database initialization completed.");

    // 2. Partner migration
    // Existing database records will be preserved.
    await runPartnerMigration();

    console.log("Partner migration completed.");

    // 3. Commission safety migration
    // Existing orders and financial records will be preserved.
    await runCommissionSafetyMigration();

    console.log("Commission safety migration completed.");

    // 4. Product and Package Cost migration
    // Adds cost columns and cost_snapshot if missing.
    // Existing order snapshots are not rewritten.
    await runProductCostMigration();

    console.log("Product cost migration completed.");

    // 5. Start automatic commission release worker
    startCommissionWorker(pool);

    console.log("Commission worker started.");

    // 6. Start HTTP server
    const server = app.listen(PORT, "0.0.0.0", () => {
      console.log(`Rubalia API running on port ${PORT}`);
      console.log("Cloudinary upload route registered.");
      console.log("Payment route registered.");
      console.log("Referral route registered.");
      console.log("Commission route registered.");
      console.log("Refund route registered.");
      console.log("Product cost management enabled.");
      console.log("Package cost management enabled.");
    });

    // =================================================
    // GRACEFUL SHUTDOWN
    // =================================================

    let shuttingDown = false;

    async function shutdown(signal) {
      if (shuttingDown) return;

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
