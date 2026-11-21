
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

const MAX_ITEMS = 30;
const MAX_QUANTITY = 100;

function validId(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

function validQuantity(value) {
  return Number.isInteger(Number(value)) &&
    Number(value) > 0 &&
    Number(value) <= MAX_QUANTITY;
}

function cleanShipping(body) {
  const shippingName = String(body.shippingName || "").trim();
  const shippingPhone = String(body.shippingPhone || "").trim();
  const shippingAddress = String(body.shippingAddress || "").trim();

  if (
    shippingName.length < 2 ||
    shippingName.length > 120 ||
    shippingPhone.length < 6 ||
    shippingPhone.length > 30 ||
    shippingAddress.length < 5 ||
    shippingAddress.length > 2000
  ) {
    return null;
  }

  return { shippingName, shippingPhone, shippingAddress };
}

// POST /api/orders
// Customer: Product অথবা Package অর্ডার।
router.post("/", authenticateToken, async (req, res, next) => {
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    const body = req.body || {};
    const items = body.items;

    if (
      !Array.isArray(items) ||
      items.length === 0 ||
      items.length > MAX_ITEMS
    ) {
      return res.status(400).json({
        success: false,
        message: "Please provide between 1 and 30 order items."
      });
    }

    const shipping = cleanShipping(body);

    if (!shipping) {
      return res.status(400).json({
        success: false,
        message: "Please provide valid shipping details."
      });
    }

    // Validate and combine duplicate items.
    const itemMap = new Map();

    for (const item of items) {
      const type = String(item.type || "product").toLowerCase();

      if (type !== "product" && type !== "package") {
        return res.status(400).json({
          success: false,
          message: "Invalid order item type."
        });
      }

      const id = Number(
        type === "package"
          ? (item.packageId || item.id)
          : (item.productId || item.id)
      );

      const quantity = Number(item.quantity);

      if (!validId(id) || !validQuantity(quantity)) {
        return res.status(400).json({
          success: false,
          message: "One or more order items are invalid."
        });
      }

      const key = `${type}:${id}`;
      const previous = itemMap.get(key);

      const totalQuantity =
        (previous ? previous.quantity : 0) + quantity;

      if (totalQuantity > MAX_QUANTITY) {
        return res.status(400).json({
          success: false,
          message: "Maximum quantity per item is 100."
        });
      }

      itemMap.set(key, {
        type,
        id,
        quantity: totalQuantity
      });
    }

    await client.query("BEGIN");
    transactionStarted = true;

    let totalAmount = 0;
    const orderItems = [];

    // Process every item using database prices and stock.
    for (const requested of itemMap.values()) {
      if (requested.type === "product") {
        const result = await client.query(
          `SELECT id, name, price, stock
           FROM products
           WHERE id = $1
             AND status = 'active'
           FOR UPDATE`,
          [requested.id]
        );

        if (!result.rows.length) {
          throw Object.assign(
            new Error("A selected product is unavailable."),
            { statusCode: 400 }
          );
        }

        const product = result.rows[0];

        if (Number(product.stock) < requested.quantity) {
          throw Object.assign(
            new Error(`Insufficient stock for ${product.name}.`),
            { statusCode: 409 }
          );
        }

        const unitPrice = Number(product.price);
        const subtotal = unitPrice * requested.quantity;

        if (!Number.isFinite(subtotal)) {
          throw new Error("Invalid product price.");
        }

        totalAmount += subtotal;

        orderItems.push({
          type: "product",
          productId: product.id,
          packageId: null,
          productName: product.name,
          unitPrice,
          quantity: requested.quantity,
          subtotal
        });

        await client.query(
          `UPDATE products
           SET stock = stock - $1,
               updated_at = NOW()
           WHERE id = $2`,
          [requested.quantity, product.id]
        );
      } else {
        const result = await client.query(
          `SELECT id, name, price, stock, status
           FROM packages
           WHERE id = $1
             AND status = 'active'
           FOR UPDATE`,
          [requested.id]
        );

        if (!result.rows.length) {
          throw Object.assign(
            new Error("A selected package is unavailable."),
            { statusCode: 400 }
          );
        }

        const packageItem = result.rows[0];

        if (Number(packageItem.stock) < requested.quantity) {
          throw Object.assign(
            new Error(`Insufficient stock for ${packageItem.name}.`),
            { statusCode: 409 }
          );
        }

        const unitPrice = Number(packageItem.price);
        const subtotal = unitPrice * requested.quantity;

        if (!Number.isFinite(subtotal)) {
          throw new Error("Invalid package price.");
        }

        totalAmount += subtotal;

        orderItems.push({
          type: "package",
          productId: null,
          packageId: packageItem.id,
          productName: packageItem.name,
          unitPrice,
          quantity: requested.quantity,
          subtotal
        });

        await client.query(
          `UPDATE packages
           SET stock = stock - $1,
               updated_at = NOW()
           WHERE id = $2`,
          [requested.quantity, packageItem.id]
        );
      }
    }

    if (
      !Number.isFinite(totalAmount) ||
      totalAmount < 0 ||
      totalAmount > 999999999999
    ) {
      throw new Error("Invalid order total.");
    }

    const orderNumber =
      "RUB-" +
      Date.now() +
      "-" +
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
        shipping.shippingName,
        shipping.shippingPhone,
        shipping.shippingAddress
      ]
    );

    const order = orderResult.rows[0];

    for (const item of orderItems) {
      await client.query(
        `INSERT INTO order_items (
          order_id,
          product_id,
          package_id,
          item_type,
          product_name,
          unit_price,
          quantity,
          subtotal
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          order.id,
          item.productId,
          item.packageId,
          item.type,
          item.productName,
          item.unitPrice.toFixed(2),
          item.quantity,
          item.subtotal.toFixed(2)
        ]
      );
    }

    await client.query("COMMIT");
    transactionStarted = false;

    return res.status(201).json({
      success: true,
      message: "Order placed successfully.",
      order: {
        id: order.id,
        order_number: order.order_number,
        total_amount: order.total_amount,
        status: order.status,
        created_at: order.created_at,
        shipping_name: order.shipping_name,
        shipping_phone: order.shipping_phone,
        shipping_address: order.shipping_address,
        items: orderItems
      }
    });
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => {});
    }

    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message
      });
    }

    next(error);
  } finally {
    client.release();
  }
});

// GET /api/orders
// Customer: নিজের অর্ডার দেখবে।
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
              'type', COALESCE(oi.item_type, 'product'),
              'productId', oi.product_id,
              'packageId', oi.package_id,
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
// Admin: সব অর্ডার দেখবে।
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
                'type', COALESCE(oi.item_type, 'product'),
                'productId', oi.product_id,
                'packageId', oi.package_id,
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
// Admin: অর্ডারের অবস্থা পরিবর্তন।
router.patch(
  "/:id/status",
  authenticateToken,
  requireAdmin,
  async (req, res, next) => {
    try {
      const orderId = Number(req.params.id);
      const status = String(req.body.status || "").trim();

      if (!validId(orderId)) {
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

      if (!result.rows.length) {
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
