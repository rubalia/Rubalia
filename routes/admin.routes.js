const express = require("express");

const pool = require("../config/database");
const { authenticateToken } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/admin");

const router = express.Router();

// All routes in this file require Admin authentication.
router.use(authenticateToken, requireAdmin);

// GET /api/admin/dashboard
// Admin dashboard summary.
router.get("/dashboard", async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users)::BIGINT AS total_users,
        (SELECT COUNT(*) FROM users WHERE status = 'active')::BIGINT AS active_users,
        (SELECT COUNT(*) FROM products)::BIGINT AS total_products,
        (SELECT COUNT(*) FROM products WHERE status = 'active')::BIGINT AS active_products,
        (SELECT COUNT(*) FROM orders)::BIGINT AS total_orders,
        (SELECT COUNT(*) FROM orders WHERE status = 'pending')::BIGINT AS pending_orders,
        (SELECT COUNT(*) FROM orders WHERE status = 'delivered')::BIGINT AS delivered_orders
    `);

    return res.json({
      success: true,
      dashboard: result.rows[0]
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/admin/users
// Admin: List users with pagination.
router.get("/users", async (req, res, next) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(
      100,
      Math.max(1, Number.parseInt(req.query.limit, 10) || 20)
    );

    const offset = (page - 1) * limit;

    const search =
      typeof req.query.search === "string"
        ? req.query.search.trim().slice(0, 100)
        : "";

    const status =
      typeof req.query.status === "string"
        ? req.query.status.trim()
        : "";

    const conditions = [];
    const values = [];

    if (search) {
      values.push(`%${search}%`);
      conditions.push(
        `(full_name ILIKE $${values.length} OR email ILIKE $${values.length})`
      );
    }

    if (status) {
      if (!["active", "inactive", "suspended"].includes(status)) {
        return res.status(400).json({
          success: false,
          message: "Invalid user status filter."
        });
      }

      values.push(status);
      conditions.push(`status = $${values.length}`);
    }

    const whereClause = conditions.length
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    const countResult = await pool.query(
      `SELECT COUNT(*)::BIGINT AS total
       FROM users
       ${whereClause}`,
      values
    );

    const listValues = [...values, limit, offset];

    const usersResult = await pool.query(
      `SELECT
        id,
        full_name,
        email,
        role,
        status,
        sponsor_id,
        created_at,
        updated_at
       FROM users
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${values.length + 1}
       OFFSET $${values.length + 2}`,
      listValues
    );

    return res.json({
      success: true,
      pagination: {
        page,
        limit,
        total: Number(countResult.rows[0].total),
        totalPages: Math.ceil(
          Number(countResult.rows[0].total) / limit
        )
      },
      users: usersResult.rows
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/admin/orders
// Admin: List recent orders.
router.get("/orders", async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT
        o.id,
        o.order_number,
        o.user_id,
        u.full_name AS customer_name,
        u.email AS customer_email,
        o.total_amount,
        o.status,
        o.created_at
       FROM orders o
       JOIN users u ON u.id = o.user_id
       ORDER BY o.created_at DESC
       LIMIT 100`
    );

    return res.json({
      success: true,
      orders: result.rows
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
