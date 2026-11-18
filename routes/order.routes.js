const express = require("express");
const crypto = require("crypto");

const pool = require("../config/database");
const { authenticateToken } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/admin");

const router = express.Router();

const ORDER_STATUSES = [
  "pending",
  "confirmed",
  "processing",
  "shipped",
  "delivered",
  "cancelled"
];

// POST /api/orders
// Customer: Place a new order.
router.post("/", authenticateToken, async (req, res, next) => {
  const client = await pool.connect();

  try {
    const {
      items,
      shippingName,
      shippingPhone,
      shippingAddress
    } = req.body;

    if (
      !Array.isArray(items) ||
      items.length === 0 ||
      items.length > 30
    ) {
      return res.status(400).json({
        success: false,
        message: "Please provide between 1 and 30 order items."
      });
    }

    const cleanName =
      typeof shippingName === "string" ? shippingName.trim() : "";

    const cleanPhone =
      typeof shippingPhone === "string" ? shippingPhone.trim() : "";

    const cleanAddress =
      typeof shippingAddress === "string" ? shippingAddress.trim() : "";

    if (
      cleanName.length < 2 ||
      cleanName.length > 120 ||
      cleanPhone.length < 6 ||
      cleanPhone.length > 30 ||
      cleanAddress.length < 5 ||
      cleanAddress.length > 2000
    ) {
      return res.status(400).json({
        success: false,
        message: "Please provide valid shipping details."
      });
    }

    const quantities = new Map();

    for (const item of items) {
      const productId = Number(item.productId);
      const quantity = Number(item.quantity);

      if (
        !Number.isSafeInteger(productId) ||
        productId <= 0 ||
        !Number.isInteger(quantity) ||
        quantity <= 0 ||
        quantity > 100
      ) {
        return res.status(400).json({
          success: false,
          message: "One or more order items are invalid."
        });
      }

      quantities.set(
        productId,
        (quantities.get(productId) || 0) + quantity
      );
    }

    for (const quantity of quantities.values()) {
      if (quantity > 100) {
        return res.status(400).json({
          success: false,
          message: "Maximum quantity per product is 100."
        });
      }
    }

    await client.query("BEGIN");

    const productIds = [...quantities.keys()].sort((a, b) => a - b);

    const productResult = await client.query(
      `SELECT id, name, price, stock
       FROM products
       WHERE id = ANY($1::bigint[])
         AND status = 'active'
       ORDER BY id
       FOR UPDATE`,
      [productIds]
    );

    if (productResult.rows.length !== productIds.length) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        success: false,
        message: "One or more products are unavailable."
      });
    }

    const productMap = new Map(
      productResult.rows.map(product => [
        String(product.id),
        product
      ])
    );

    let totalAmount = 0;
    const orderItems = [];

    for (const [productId, quantity] of quantities.entries()) {
      const product = productMap.get(String(productId));

      if (!product || Number(product.stock) < quantity) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          success: false,
          message: "Insufficient stock for one or more products."
        });
      }

      const unitPrice = Number(product.price);
      const subtotal = unitPrice * quantity;

      if (
        !Number.isFinite(unitPrice) ||
        !Number.isFinite(subtotal)
      ) {
        throw new Error("Invalid product price in database.");
      }

      totalAmount += subtotal;

      orderItems.push({
        productId: product.id,
        productName: product.name,
        unitPrice,
        quantity,
        subtotal
      });
    }

    const orderNumber =
      "RUB-" + Date.now() + "-" +
      crypto.randomBytes(3).toString("hex").toUpperCase();

    const orderResult = await client.query(
      `INSERT INTO orders (
        user_id,
        order_number,
        total_amount,
        shipping_name,
        shipping_phone,
        shipping_address
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *`,
      [
        req.auth.id,
        orderNumber,
        totalAmount.toFixed(2),
        cleanName,
        cleanPhone,
        cleanAddress
      ]
    );

    const order = orderResult.rows[0];

    for (const item of orderItems) {
      await client.query(
        `INSERT INTO order_items (
          order_id,
          product_id,
          product_name,
          unit_price,
          quantity,
          subtotal
        )
        VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          order.id,
          item.productId,
          item.productName,
          item.unitPrice.toFixed(2),
          item.quantity,
          item.subtotal.toFixed(2)
        ]
      );

      await client.query(
        `UPDATE products
         SET stock = stock - $1,
             updated_at = NOW()
         WHERE id = $2`,
        [item.quantity, item.productId]
      );
    }

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "Order placed successfully.",
      order: {
        ...order,
        items: orderItems
      }
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

// GET /api/orders
// Customer: View their own orders.
router.get("/", authenticateToken, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT
        o.id,
        o.order_number,
        o.total_amount,
        o.shipping_name,
        o.shipping_phone,
        o.shipping_address,
        o.status,
        o.created_at,
        COALESCE(
          json_agg(
            json_build_object(
              'productId', oi.product_id,
              'productName', oi.product_name,
              'unitPrice', oi.unit_price,
              'quantity', oi.quantity,
              'subtotal', oi.subtotal
            )
          ) FILTER (WHERE oi.id IS NOT NULL),
          '[]'
        ) AS items
       FROM orders o
       LEFT JOIN order_items oi ON oi.order_id = o.id
       WHERE o.user_id = $1
       GROUP BY o.id
       ORDER BY o.created_at DESC`,
      [req.auth.id]
    );

    return res.json({
      success: true,
      orders: result.rows
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/orders/admin/all
// Admin: View all orders.
router.get(
  "/admin/all",
  authenticateToken,
  requireAdmin,
  async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT
          o.id,
          o.order_number,
          o.user_id,
          u.full_name AS customer_name,
          u.email AS customer_email,
          o.total_amount,
          o.shipping_name,
          o.shipping_phone,
          o.shipping_address,
          o.status,
          o.created_at,
          COALESCE(
            json_agg(
              json_build_object(
                'productId', oi.product_id,
                'productName', oi.product_name,
                'unitPrice', oi.unit_price,
                'quantity', oi.quantity,
                'subtotal', oi.subtotal
              )
            ) FILTER (WHERE oi.id IS NOT NULL),
            '[]'
          ) AS items
         FROM orders o
         JOIN users u ON u.id = o.user_id
         LEFT JOIN order_items oi ON oi.order_id = o.id
         GROUP BY o.id, u.full_name, u.email
         ORDER BY o.created_at DESC
         LIMIT 500`
      );

      return res.json({
        success: true,
        orders: result.rows
      });
    } catch (error) {
      next(error);
    }
  }
);

// PATCH /api/orders/:id/status
// Admin: Update order status.
router.patch(
  "/:id/status",
  authenticateToken,
  requireAdmin,
  async (req, res, next) => {
    try {
      const orderId = Number(req.params.id);
      const { status } = req.body;

      if (!Number.isSafeInteger(orderId) || orderId <= 0) {
        return res.status(400).json({
          success: false,
          message: "Invalid order ID."
        });
      }

      if (!ORDER_STATUSES.includes(status)) {
        return res.status(400).json({
          success: false,
          message: "Invalid order status."
        });
      }

      const result = await pool.query(
        `UPDATE orders
         SET status = $1,
             updated_at = NOW()
         WHERE id = $2
         RETURNING id, order_number, status, updated_at`,
        [status, orderId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Order not found."
        });
      }

      return res.json({
        success: true,
        message: "Order status updated.",
        order: result.rows[0]
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
