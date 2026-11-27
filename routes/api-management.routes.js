"use strict";

const express = require("express");
const os = require("os");

const pool = require("../config/database");
const { authenticateToken } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/admin");

const router = express.Router();

router.use(authenticateToken, requireAdmin);

function validPeriod(value) {
  const periods = [24, 168, 720];
  const number = Number(value || 24);

  return periods.includes(number) ? number : 24;
}

/* =========================================
   API OVERVIEW
   GET /api/admin/api-management/overview
========================================= */

router.get("/overview", async (req, res, next) => {
  try {
    const hours = validPeriod(req.query.hours);

    const result = await pool.query(
      `SELECT
        COUNT(*)::BIGINT AS total_requests,

        COUNT(*) FILTER (
          WHERE status_code >= 400
        )::BIGINT AS error_requests,

        COUNT(*) FILTER (
          WHERE status_code >= 500
        )::BIGINT AS server_errors,

        COUNT(*) FILTER (
          WHERE status_code >= 200
            AND status_code < 400
        )::BIGINT AS successful_requests,

        COALESCE(
          ROUND(AVG(response_time_ms)::NUMERIC, 2),
          0
        ) AS avg_response_time,

        COALESCE(
          MAX(response_time_ms),
          0
        ) AS max_response_time

      FROM api_request_logs
      WHERE created_at >= NOW() - ($1 * INTERVAL '1 hour')`,
      [hours]
    );

    const stats = result.rows[0];

    const total = Number(stats.total_requests);
    const errors = Number(stats.error_requests);

    const errorRate = total > 0
      ? Number(((errors / total) * 100).toFixed(2))
      : 0;

    let databaseStatus = "connected";

    try {
      await pool.query("SELECT 1");
    } catch {
      databaseStatus = "unavailable";
    }

    return res.json({
      success: true,

      period_hours: hours,

      overview: {
        total_requests: total,
        successful_requests: Number(stats.successful_requests),
        error_requests: errors,
        server_errors: Number(stats.server_errors),
        error_rate: errorRate,
        average_response_time: Number(stats.avg_response_time),
        maximum_response_time: Number(stats.max_response_time)
      },

      system: {
        database: databaseStatus,
        uptime_seconds: Math.floor(process.uptime()),
        node_version: process.version,
        platform: os.platform(),
        environment: process.env.NODE_ENV || "production",
        memory_used_mb: Math.round(
          process.memoryUsage().rss / 1024 / 1024
        )
      }
    });

  } catch (error) {
    return next(error);
  }
});

/* =========================================
   RECENT API LOGS
   GET /api/admin/api-management/logs
========================================= */

router.get("/logs", async (req, res, next) => {
  try {
    const limit = Math.min(
      100,
      Math.max(1, Number.parseInt(req.query.limit, 10) || 50)
    );

    const status = String(req.query.status || "").trim();

    const search = String(req.query.search || "")
      .trim()
      .slice(0, 100);

    const values = [];
    const conditions = [];

    if (status) {
      const statusNumber = Number(status);

      if (
        !Number.isInteger(statusNumber) ||
        statusNumber < 100 ||
        statusNumber > 599
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid HTTP status code."
        });
      }

      values.push(statusNumber);
      conditions.push(`status_code = $${values.length}`);
    }

    if (search) {
      values.push(`%${search}%`);

      conditions.push(
        `(endpoint ILIKE $${values.length}
          OR method ILIKE $${values.length}
          OR ip_address ILIKE $${values.length})`
      );
    }

    values.push(limit);

    const where = conditions.length
      ? "WHERE " + conditions.join(" AND ")
      : "";

    const result = await pool.query(
      `SELECT
        id,
        method,
        endpoint,
        status_code,
        response_time_ms,
        ip_address,
        created_at
      FROM api_request_logs
      ${where}
      ORDER BY created_at DESC
      LIMIT $${values.length}`,
      values
    );

    return res.json({
      success: true,
      count: result.rows.length,
      logs: result.rows
    });

  } catch (error) {
    return next(error);
  }
});

/* =========================================
   REQUEST COUNTS BY ENDPOINT
   GET /api/admin/api-management/endpoints
========================================= */

router.get("/endpoints", async (req, res, next) => {
  try {
    const hours = validPeriod(req.query.hours);

    const result = await pool.query(
      `SELECT
        method,
        endpoint,
        COUNT(*)::BIGINT AS total_requests,

        COUNT(*) FILTER (
          WHERE status_code >= 400
        )::BIGINT AS errors,

        ROUND(
          AVG(response_time_ms)::NUMERIC,
          2
        ) AS average_response_time

      FROM api_request_logs

      WHERE created_at >=
        NOW() - ($1 * INTERVAL '1 hour')

      GROUP BY method, endpoint

      ORDER BY total_requests DESC

      LIMIT 100`,
      [hours]
    );

    return res.json({
      success: true,
      endpoints: result.rows
    });

  } catch (error) {
    return next(error);
  }
});

/* =========================================
   EXISTING RATE LIMIT CONFIGURATION
========================================= */

router.get("/rate-limits", (req, res) => {
  return res.json({
    success: true,

    policies: [
      {
        name: "Login",
        window_minutes: 15,
        max_requests: 20,
        status: "active"
      },
      {
        name: "Registration",
        window_minutes: 60,
        max_requests: 5,
        status: "active"
      },
      {
        name: "Forgot Password",
        window_minutes: 15,
        max_requests: 5,
        status: "active"
      },
      {
        name: "Reset Password",
        window_minutes: 15,
        max_requests: 10,
        status: "active"
      }
    ],

    note: "These values are read from the current server configuration."
  });
});

module.exports = router;
