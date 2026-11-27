"use strict";

const pool = require("../config/database");

function apiLogger(req, res, next) {
  const startedAt = process.hrtime.bigint();

  res.on("finish", () => {
    const durationMs =
      Number(process.hrtime.bigint() - startedAt) / 1e6;

    const path = String(req.originalUrl || req.url)
      .split("?")[0]
      .slice(0, 500);

    // Monitoring endpoint নিজের request log করবে না।
    if (
      !path.startsWith("/api/") ||
      path.startsWith("/api/admin/api-management") ||
      path === "/api/health"
    ) {
      return;
    }

    const ip =
      req.ip ||
      req.socket?.remoteAddress ||
      "unknown";

    pool.query(
      `INSERT INTO api_request_logs (
        method,
        endpoint,
        status_code,
        response_time_ms,
        ip_address,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, NOW())`,
      [
        String(req.method).slice(0, 12),
        path,
        Number(res.statusCode) || 0,
        Math.max(0, durationMs),
        String(ip).slice(0, 100)
      ]
    ).catch(error => {
      console.error("API request logging failed:", error.message);
    });
  });

  next();
}

module.exports = apiLogger;
