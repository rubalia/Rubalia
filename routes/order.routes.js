
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

function makeOrderNumber() {
  return (
    "RUB-" +
    Date.now() +
    "-" +
    crypto.randomBytes(3).toString("hex").toUpperCase()
  );
}

// =====================================================
// POST /api/orders
// Customer: Wallet payment দিয়ে অর্ডার তৈরি
// COD এবং unverified gateway payment গ্রহণ করা হবে না।
// =====================================================

router.post("/", authenticateToken, async (req, res, next) => {
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    const body = req.body || {};

    if (String(body.paymentMethod || "").toLowerCase() !== "wallet") {
      return res.status(400).json({
        success: false,
        message:
          "Only Wallet Balance payment is accepted through this endpoint. Cash on Delivery is not available."
      });
    }

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

    // Create wallet if it does not exist.
    await client.query(
      `INSERT INTO wallets (user_id)
       VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [req.auth.id]
    );

    // Lock wallet to prevent simultaneous double spending.
    const walletResult = await client.query(
      `SELECT id, balance
       FROM wallets
       WHERE user_id = $1
       FOR UPDATE`,
      [req.auth.id]
    );

    if (!walletResult.rows.length) {
      throw Object.assign(
        new Error("Wallet could not be accessed."),
        { statusCode: 400 }
      );
    }

    const wallet = walletResult.rows[0];

    let totalCents = 0;
    const orderItems = [];

    // Check stock and lock selected products/packages.
    for (const requested of itemMap.values()) {
      const isPackage = requested.type === "package";

      const result = await client.query(
        isPackage
          ? `SELECT id, name, price, stock
             FROM packages
             WHERE id = $1 AND status = 'active'
             FOR UPDATE`
          : `SELECT id, name, price, stock
             FROM products
             WHERE id = $1 AND status = 'active'
             FOR UPDATE`,
        [requested.id]
      );

      if (!result.rows.length) {
        throw Object.assign(
          new Error(
            isPackage
              ? "A selected package is unavailable."
              : "A selected product is unavailable."
          ),
          { statusCode: 400 }
        );
      }

      const item = result.rows[0];

      if (Number(item.stock) < requested.quantity) {
        throw Object.assign(
          new Error(`Insufficient stock for ${item.name}.`),
          { statusCode: 409 }
        );
      }

      // Calculate money in paisa to avoid floating-point errors.
      const unitCents = Math.round(Number(item.price) * 100);

      if (!Number.isSafeInteger(unitCents) || unitCents < 0) {
        throw new Error("Invalid item price.");
      }

      const subtotalCents = unitCents * requested.quantity;
      totalCents += subtotalCents;

      if (
        !Number.isSafeInteger(totalCents) ||
        totalCents > 99999999999900
      ) {
        throw new Error("Invalid order total.");
      }

      orderItems.push({
        type: requested.type,
        productId: isPackage ? null : item.id,
        packageId: isPackage ? item.id : null,
        productName: item.name,
        unitPrice: unitCents / 100,
        quantity: requested.quantity,
        subtotal: subtotalCents / 100
      });
    }

    if (totalCents <= 0) {
      throw Object.assign(
        new Error("Order total must be greater than zero."),
        { statusCode: 400 }
      );
    }

    const totalAmount = totalCents / 100;
    const balanceCents = Math.round(Number(wallet.balance) * 100);

    if (balanceCents < totalCents) {
      throw Object.assign(
        new Error(
          "Insufficient wallet balance. Please add funds before placing this order."
        ),
        { statusCode: 409 }
      );
    }

    // Deduct wallet balance atomically.
    const debit = await client.query(
      `UPDATE wallets
       SET balance = balance - $1,
           updated_at = NOW()
       WHERE id = $2
         AND balance >= $1
       RETURNING balance`,
      [totalAmount.toFixed(2), wallet.id]
    );

    if (!debit.rows.length) {
      throw Object.assign(
        new Error("Insufficient wallet balance."),
        { statusCode: 409 }
      );
    }

    const orderNumber = makeOrderNumber();

    // Wallet payment is already paid.
    // Order itself remains pending until Admin confirms it.
    const orderResult = await client.query(
      `INSERT INTO orders (
        user_id,
        order_number,
        total_amount,
        shipping_name,
        shipping_phone,
        shipping_address,
        status,
        payment_method,
        payment_status
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'pending', 'wallet', 'paid')
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

    // Save order items and reduce stock.
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

      await client.query(
        item.type === "package"
          ? `UPDATE packages
             SET stock = stock - $1,
                 updated_at = NOW()
             WHERE id = $2
               AND stock >= $1`
          : `UPDATE products
             SET stock = stock - $1,
                 updated_at = NOW()
             WHERE id = $2
               AND stock >= $1`,
        [item.quantity, item.type === "package"
          ? item.packageId
          : item.productId]
      );
    }

    // Record wallet purchase.
    await client.query(
      `INSERT INTO wallet_transactions (
        wallet_id,
        transaction_type,
        amount,
        reference,
        description,
        status
      )
      VALUES ($1, 'purchase', $2, $3, $4, 'completed')`,
      [
        wallet.id,
        totalAmount.toFixed(2),
        orderNumber,
        "Payment for order " + orderNumber
      ]
    );

    await client.query("COMMIT");
    transactionStarted = false;

    return res.status(201).json({
      success: true,
      message:
        "Wallet payment successful. Your order has been placed and is waiting for Admin confirmation.",
      order: {
        id: order.id,
        order_number: order.order_number,
        total_amount: order.total_amount,
        status: order.status,
        payment_method: order.payment_method,
        payment_status: order.payment_status,
        created_at: order.created_at,
        shipping_name: order.shipping_name,
        shipping_phone: order.shipping_phone,
        shipping_address: order.shipping_address,
        items: orderItems,
        wallet_balance: debit.rows[0].balance
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

// =====================================================
// GET /api/orders
// Customer: নিজের অর্ডার দেখবে।
// =====================================================

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
        o.payment_method,
        o.payment_status,
        o.created_at,
        o.updated_at,
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

// =====================================================
// GET /api/orders/admin/all
// Admin: সব অর্ডার দেখবে।
// =====================================================

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
          o.payment_method,
          o.payment_status,
          o.created_at,
          o.updated_at,
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

// =====================================================
// PATCH /api/orders/:id/status
// Admin: অর্ডারের অবস্থা পরিবর্তন করবে।
// =====================================================

router.patch(
  "/:id/status",
  authenticateToken,
  requireAdmin,
  async (req, res, next) => {
    const client = await pool.connect();
    let transactionStarted = false;

    try {
      const orderId = Number(req.params.id);
      const status = String(req.body.status || "").trim().toLowerCase();

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

      await client.query("BEGIN");
      transactionStarted = true;

      const currentResult = await client.query(
        `SELECT
          id,
          order_number,
          status,
          payment_method,
          payment_status
         FROM orders
         WHERE id = $1
         FOR UPDATE`,
        [orderId]
      );

      if (!currentResult.rows.length) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(404).json({
          success: false,
          message: "Order not found."
        });
      }

      const current = currentResult.rows[0];

      // Do not process an order with an unpaid gateway request.
      // Legacy orders are retained for historical compatibility.
      if (
        current.payment_status !== "paid" &&
        current.payment_method !== "legacy"
      ) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(409).json({
          success: false,
          message:
            "This order cannot be processed because its payment has not been verified."
        });
      }

      // Delivered and cancelled orders cannot be reopened.
      if (
        current.status === "delivered" ||
        current.status === "cancelled"
      ) {
        if (status !== current.status) {
          await client.query("ROLLBACK");
          transactionStarted = false;

          return res.status(409).json({
            success: false,
            message:
              "A delivered or cancelled order cannot be changed."
          });
        }
      }

      const result = await client.query(
        `UPDATE orders
         SET status = $1,
             updated_at = NOW()
         WHERE id = $2
         RETURNING
           id,
           order_number,
           status,
           payment_method,
           payment_status,
           updated_at`,
        [status, orderId]
      );

      await client.query("COMMIT");
      transactionStarted = false;

      return res.json({
        success: true,
        message: "Order status updated successfully.",
        order: result.rows[0]
      });

    } catch (error) {
      if (transactionStarted) {
        await client.query("ROLLBACK").catch(() => {});
      }

      next(error);

    } finally {
      client.release();
    }
  }
);

module.exports = router;
