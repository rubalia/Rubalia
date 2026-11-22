
"use strict";

const express = require("express");
const crypto = require("crypto");

const pool = require("../config/database");
const { authenticateToken } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/admin");

const router = express.Router();

const GATEWAYS = {
  bkash: {
    name: "bKash",
    currency: "BDT",
    network: null
  },
  nagad: {
    name: "Nagad",
    currency: "BDT",
    network: null
  },
  rocket: {
    name: "Rocket",
    currency: "BDT",
    network: null
  },
  upay: {
    name: "Upay",
    currency: "BDT",
    network: null
  },
  muktopay: {
    name: "MuktoPay",
    currency: "BDT",
    network: null
  },
  usdt_bep20: {
    name: "USDT (BEP20)",
    currency: "USDT",
    network: "BEP20"
  }
};

const MAX_ITEMS = 30;
const MAX_QUANTITY = 100;

function validId(value) {
  return (
    Number.isSafeInteger(Number(value)) &&
    Number(value) > 0
  );
}

function validQuantity(value) {
  return (
    Number.isInteger(Number(value)) &&
    Number(value) > 0 &&
    Number(value) <= MAX_QUANTITY
  );
}

function cleanText(value, maxLength = 255) {
  return String(value || "")
    .trim()
    .slice(0, maxLength);
}

function cleanShipping(body) {
  const shippingName = cleanText(body.shippingName, 120);
  const shippingPhone = cleanText(body.shippingPhone, 30);
  const shippingAddress = cleanText(body.shippingAddress, 2000);

  if (
    shippingName.length < 2 ||
    shippingPhone.length < 6 ||
    shippingAddress.length < 5
  ) {
    return null;
  }

  return {
    shippingName,
    shippingPhone,
    shippingAddress
  };
}

function normalizeItems(items) {
  if (
    !Array.isArray(items) ||
    items.length < 1 ||
    items.length > MAX_ITEMS
  ) {
    return null;
  }

  const itemMap = new Map();

  for (const item of items) {
    const type = String(item.type || "product").toLowerCase();

    if (type !== "product" && type !== "package") {
      return null;
    }

    const id = Number(
      type === "package"
        ? (item.packageId || item.id)
        : (item.productId || item.id)
    );

    const quantity = Number(item.quantity);

    if (!validId(id) || !validQuantity(quantity)) {
      return null;
    }

    const key = `${type}:${id}`;
    const previous = itemMap.get(key);

    const totalQuantity =
      (previous ? previous.quantity : 0) + quantity;

    if (totalQuantity > MAX_QUANTITY) {
      return null;
    }

    itemMap.set(key, {
      type,
      id,
      quantity: totalQuantity
    });
  }

  return Array.from(itemMap.values());
}

function makeReference() {
  return (
    "RBP-" +
    Date.now() +
    "-" +
    crypto.randomBytes(5).toString("hex").toUpperCase()
  );
}

function makeOrderNumber() {
  return (
    "RUB-" +
    Date.now() +
    "-" +
    crypto.randomBytes(3).toString("hex").toUpperCase()
  );
}

function moneyToCents(value) {
  const cents = Math.round(Number(value) * 100);

  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new Error("Invalid price.");
  }

  return cents;
}

function transactionReference(value, gateway) {
  const reference = cleanText(value, 180);

  if (reference.length < 5) {
    return null;
  }

  if (/[\u0000-\u001F\u007F]/.test(reference)) {
    return null;
  }

  if (
    gateway === "usdt_bep20" &&
    !/^0x[a-fA-F0-9]{64}$/.test(reference)
  ) {
    return null;
  }

  return reference;
}

function parseCheckoutData(value) {
  if (typeof value === "string") {
    return JSON.parse(value);
  }

  return value;
}

function sendError(res, status, message) {
  return res.status(status).json({
    success: false,
    message
  });
}


// =========================================================
// CUSTOMER: AVAILABLE PAYMENT METHODS
// GET /api/payment/methods
// =========================================================

router.get(
  "/methods",
  authenticateToken,
  async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT
          gateway,
          enabled,
          display_name,
          instructions,
          account_number,
          wallet_address,
          network,
          usdt_rate
         FROM payment_gateway_settings
         ORDER BY gateway`
      );

      const settings = new Map(
        result.rows.map(row => [row.gateway, row])
      );

      const methods = Object.entries(GATEWAYS).map(
        ([gateway, definition]) => {
          const setting = settings.get(gateway);

          return {
            gateway,
            name: definition.name,
            currency: definition.currency,
            network: definition.network,
            enabled: Boolean(setting && setting.enabled),
            display_name:
              setting?.display_name || definition.name,
            instructions:
              setting?.instructions || null,
            account_number:
              setting?.account_number || null,
            wallet_address:
              gateway === "usdt_bep20"
                ? setting?.wallet_address || null
                : null,
            usdt_rate:
              gateway === "usdt_bep20"
                ? setting?.usdt_rate || null
                : null
          };
        }
      );

      return res.json({
        success: true,
        methods
      });

    } catch (error) {
      next(error);
    }
  }
);


// =========================================================
// CUSTOMER: CREATE PAYMENT REQUEST
// POST /api/payment/request
// =========================================================

router.post(
  "/request",
  authenticateToken,
  async (req, res, next) => {
    try {
      const gateway = String(
        req.body.gateway || ""
      ).toLowerCase().trim();

      if (!GATEWAYS[gateway]) {
        return sendError(res, 400, "Invalid payment gateway.");
      }

      const txReference = transactionReference(
        req.body.transactionReference,
        gateway
      );

      if (!txReference) {
        return sendError(
          res,
          400,
          gateway === "usdt_bep20"
            ? "Please provide a valid BEP20 transaction hash."
            : "Please provide a valid transaction reference."
        );
      }

      const items = normalizeItems(req.body.items);

      if (!items) {
        return sendError(res, 400, "Invalid order items.");
      }

      const shipping = cleanShipping(req.body);

      if (!shipping) {
        return sendError(
          res,
          400,
          "Please provide valid delivery information."
        );
      }

      const settingResult = await pool.query(
        `SELECT
          gateway,
          enabled,
          display_name,
          instructions,
          account_number,
          wallet_address,
          network,
          usdt_rate
         FROM payment_gateway_settings
         WHERE gateway = $1`,
        [gateway]
      );

      if (
        !settingResult.rows.length ||
        !settingResult.rows[0].enabled
      ) {
        return sendError(
          res,
          400,
          "This payment method is currently unavailable."
        );
      }

      const setting = settingResult.rows[0];

      if (
        gateway !== "usdt_bep20" &&
        (!setting.account_number ||
          setting.account_number.trim().length < 5)
      ) {
        return sendError(
          res,
          400,
          "Payment account is not configured."
        );
      }

      if (
        gateway === "usdt_bep20" &&
        (
          setting.network !== "BEP20" ||
          !/^0x[a-fA-F0-9]{40}$/.test(
            String(setting.wallet_address || "")
          ) ||
          !Number.isFinite(Number(setting.usdt_rate)) ||
          Number(setting.usdt_rate) <= 0
        )
      ) {
        return sendError(
          res,
          400,
          "USDT BEP20 payment is not configured correctly."
        );
      }

      let totalCents = 0;
      const verifiedItems = [];

      for (const requested of items) {
        const isPackage = requested.type === "package";

        const result = await pool.query(
          isPackage
            ? `SELECT id, name, price, stock
               FROM packages
               WHERE id = $1 AND status = 'active'`
            : `SELECT id, name, price, stock
               FROM products
               WHERE id = $1 AND status = 'active'`,
          [requested.id]
        );

        if (!result.rows.length) {
          return sendError(
            res,
            400,
            isPackage
              ? "A selected package is unavailable."
              : "A selected product is unavailable."
          );
        }

        const item = result.rows[0];

        if (Number(item.stock) < requested.quantity) {
          return sendError(
            res,
            409,
            `Insufficient stock for ${item.name}.`
          );
        }

        const unitCents = moneyToCents(item.price);
        const subtotalCents = unitCents * requested.quantity;

        totalCents += subtotalCents;

        if (
          !Number.isSafeInteger(totalCents) ||
          totalCents <= 0 ||
          totalCents > 99999999999900
        ) {
          return sendError(res, 400, "Invalid order amount.");
        }

        verifiedItems.push({
          type: requested.type,
          id: requested.id,
          quantity: requested.quantity,
          productName: item.name,
          unitPrice: unitCents / 100,
          subtotal: subtotalCents / 100
        });
      }

      const totalAmount = totalCents / 100;

      let expectedUsdt = null;

      if (gateway === "usdt_bep20") {
        const rate = Number(setting.usdt_rate);

        expectedUsdt = Number(
          (totalAmount / rate).toFixed(6)
        );

        if (
          !Number.isFinite(expectedUsdt) ||
          expectedUsdt <= 0
        ) {
          return sendError(
            res,
            400,
            "Invalid USDT payment amount."
          );
        }
      }

      const checkoutData = {
        items: verifiedItems,
        shipping,
        totalAmount,
        currency: "BDT",
        expectedUsdt,
        usdtNetwork:
          gateway === "usdt_bep20" ? "BEP20" : null,
        walletAddress:
          gateway === "usdt_bep20"
            ? setting.wallet_address
            : null
      };

      const paymentReference = makeReference();

      /*
       * IMPORTANT:
       * amount is always BDT.
       * currency is always BDT.
       * expected_usdt stores the separate USDT amount.
       */

      const insertResult = await pool.query(
        `INSERT INTO payment_requests (
          user_id,
          payment_reference,
          gateway,
          transaction_reference,
          amount,
          currency,
          expected_usdt,
          checkout_data,
          status
        )
        VALUES ($1, $2, $3, $4, $5, 'BDT', $6, $7, 'pending')
        RETURNING
          id,
          payment_reference,
          gateway,
          transaction_reference,
          amount,
          currency,
          expected_usdt,
          status,
          created_at`,
        [
          req.auth.id,
          paymentReference,
          gateway,
          txReference,
          totalAmount.toFixed(2),
          expectedUsdt,
          JSON.stringify(checkoutData)
        ]
      );

      return res.status(201).json({
        success: true,
        message:
          "Payment request submitted. Waiting for Admin verification.",

        payment: insertResult.rows[0],

        payment_instructions: {
          gateway,
          account_number: setting.account_number || null,
          wallet_address:
            gateway === "usdt_bep20"
              ? setting.wallet_address
              : null,
          network:
            gateway === "usdt_bep20" ? "BEP20" : null,

          order_amount_bdt: totalAmount,
          expected_usdt: expectedUsdt,

          currency: "BDT",
          instructions: setting.instructions || null
        }
      });

    } catch (error) {
      if (error.code === "23505") {
        return sendError(
          res,
          409,
          "This transaction reference has already been submitted."
        );
      }

      next(error);
    }
  }
);


// =========================================================
// CUSTOMER: MY PAYMENT REQUESTS
// GET /api/payment/my-requests
// =========================================================

router.get(
  "/my-requests",
  authenticateToken,
  async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT
          id,
          payment_reference,
          gateway,
          transaction_reference,
          amount,
          currency,
          expected_usdt,
          status,
          admin_note,
          created_at,
          verified_at
         FROM payment_requests
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 100`,
        [req.auth.id]
      );

      return res.json({
        success: true,
        payments: result.rows
      });

    } catch (error) {
      next(error);
    }
  }
);


// =========================================================
// ADMIN ROUTES
// =========================================================

router.use(
  "/admin",
  authenticateToken,
  requireAdmin
);


// =========================================================
// ADMIN: PAYMENT REQUEST LIST
// GET /api/payment/admin/requests
// =========================================================

router.get(
  "/admin/requests",
  async (req, res, next) => {
    try {
      const status = cleanText(req.query.status, 20);

      const allowedStatuses = [
        "",
        "pending",
        "approved",
        "rejected"
      ];

      if (!allowedStatuses.includes(status)) {
        return sendError(
          res,
          400,
          "Invalid payment status filter."
        );
      }

      const values = [];
      let where = "";

      if (status) {
        values.push(status);
        where = "WHERE p.status = $1";
      }

      const result = await pool.query(
        `SELECT
          p.id,
          p.user_id,
          u.full_name AS customer_name,
          u.email AS customer_email,
          p.payment_reference,
          p.gateway,
          p.transaction_reference,
          p.amount,
          p.currency,
          p.expected_usdt,
          p.checkout_data,
          p.status,
          p.admin_note,
          p.created_at,
          p.verified_at,
          p.verified_by
         FROM payment_requests p
         JOIN users u ON u.id = p.user_id
         ${where}
         ORDER BY
           CASE WHEN p.status = 'pending' THEN 0 ELSE 1 END,
           p.created_at DESC
         LIMIT 300`,
        values
      );

      return res.json({
        success: true,
        payments: result.rows
      });

    } catch (error) {
      next(error);
    }
  }
);


// =========================================================
// ADMIN: PAYMENT REQUEST DETAILS
// GET /api/payment/admin/requests/:id
// =========================================================

router.get(
  "/admin/requests/:id",
  async (req, res, next) => {
    try {
      if (!validId(req.params.id)) {
        return sendError(
          res,
          400,
          "Invalid payment request ID."
        );
      }

      const result = await pool.query(
        `SELECT
          p.*,
          u.full_name AS customer_name,
          u.email AS customer_email
         FROM payment_requests p
         JOIN users u ON u.id = p.user_id
         WHERE p.id = $1`,
        [req.params.id]
      );

      if (!result.rows.length) {
        return sendError(
          res,
          404,
          "Payment request not found."
        );
      }

      return res.json({
        success: true,
        payment: result.rows[0]
      });

    } catch (error) {
      next(error);
    }
  }
);


// =========================================================
// ADMIN: APPROVE PAYMENT AND CREATE ORDER
// PATCH /api/payment/admin/requests/:id/approve
// =========================================================

router.patch(
  "/admin/requests/:id/approve",
  async (req, res, next) => {
    if (!validId(req.params.id)) {
      return sendError(
        res,
        400,
        "Invalid payment request ID."
      );
    }

    const client = await pool.connect();
    let transactionStarted = false;

    try {
      await client.query("BEGIN");
      transactionStarted = true;

      const paymentResult = await client.query(
        `SELECT *
         FROM payment_requests
         WHERE id = $1
         FOR UPDATE`,
        [req.params.id]
      );

      if (!paymentResult.rows.length) {
        throw Object.assign(
          new Error("Payment request not found."),
          { statusCode: 404 }
        );
      }

      const payment = paymentResult.rows[0];

      if (payment.status !== "pending") {
        throw Object.assign(
          new Error(
            "This payment request has already been processed."
          ),
          { statusCode: 409 }
        );
      }

      const gateway = payment.gateway;

      if (!GATEWAYS[gateway]) {
        throw Object.assign(
          new Error("Unsupported payment gateway."),
          { statusCode: 400 }
        );
      }

      const checkoutData = parseCheckoutData(
        payment.checkout_data
      );

      if (
        !checkoutData ||
        !Array.isArray(checkoutData.items) ||
        !checkoutData.shipping
      ) {
        throw Object.assign(
          new Error("Invalid payment checkout data."),
          { statusCode: 400 }
        );
      }

      const shipping = cleanShipping({
        shippingName: checkoutData.shipping.shippingName,
        shippingPhone: checkoutData.shipping.shippingPhone,
        shippingAddress: checkoutData.shipping.shippingAddress
      });

      if (!shipping) {
        throw Object.assign(
          new Error("Invalid saved delivery information."),
          { statusCode: 400 }
        );
      }

      let totalCents = 0;
      const orderItems = [];

      // Recheck product/package price and stock.
      for (const savedItem of checkoutData.items) {
        const type = String(savedItem.type || "");
        const id = Number(savedItem.id);
        const quantity = Number(savedItem.quantity);

        if (
          (type !== "product" && type !== "package") ||
          !validId(id) ||
          !validQuantity(quantity)
        ) {
          throw Object.assign(
            new Error("Invalid saved order item."),
            { statusCode: 400 }
          );
        }

        const isPackage = type === "package";

        const itemResult = await client.query(
          isPackage
            ? `SELECT
                 id, name, price, stock,
                 delivery_cost,
                 packaging_cost,
                 other_cost,
                 product_1_id,
                 product_2_id,
                 product_3_id
               FROM packages
               WHERE id = $1 AND status = 'active'
               FOR UPDATE`
            : `SELECT
                 id, name, price, stock,
                 cost_price,
                 delivery_cost,
                 packaging_cost,
                 other_cost
               FROM products
               WHERE id = $1 AND status = 'active'
               FOR UPDATE`,
          [id]
        );

        if (!itemResult.rows.length) {
          throw Object.assign(
            new Error(
              "A product or package is no longer available."
            ),
            { statusCode: 409 }
          );
        }

        const item = itemResult.rows[0];

        if (Number(item.stock) < quantity) {
          throw Object.assign(
            new Error(`Insufficient stock for ${item.name}.`),
            { statusCode: 409 }
          );
        }

        const unitCents = moneyToCents(item.price);
        const subtotalCents = unitCents * quantity;

        totalCents += subtotalCents;

        if (!Number.isSafeInteger(totalCents)) {
          throw new Error("Invalid order total.");
        }

        // =================================================
        // IMMUTABLE COST SNAPSHOT
        // =================================================

        let costSnapshot;

        if (isPackage) {
          const componentResult = await client.query(
            `SELECT id, cost_price
             FROM products
             WHERE id = ANY($1::int[])
             ORDER BY array_position($1::int[], id)`,
            [[
              item.product_1_id,
              item.product_2_id,
              item.product_3_id
            ]]
          );

          if (componentResult.rows.length !== 3) {
            throw Object.assign(
              new Error(
                "Package component cost information is incomplete."
              ),
              { statusCode: 409 }
            );
          }

          costSnapshot = {
            componentCosts: componentResult.rows.map(product => ({
              productCost: Number(
                product.cost_price || 0
              ).toFixed(2)
            })),
            deliveryCost: Number(
              item.delivery_cost || 0
            ).toFixed(2),
            packagingCost: Number(
              item.packaging_cost || 0
            ).toFixed(2),
            otherCost: Number(
              item.other_cost || 0
            ).toFixed(2)
          };

        } else {
          costSnapshot = {
            productCost: Number(
              item.cost_price || 0
            ).toFixed(2),
            deliveryCost: Number(
              item.delivery_cost || 0
            ).toFixed(2),
            packagingCost: Number(
              item.packaging_cost || 0
            ).toFixed(2),
            otherCost: Number(
              item.other_cost || 0
            ).toFixed(2)
          };
        }

        orderItems.push({
          type,
          productId: isPackage ? null : item.id,
          packageId: isPackage ? item.id : null,
          productName: item.name,
          unitPrice: unitCents / 100,
          quantity,
          subtotal: subtotalCents / 100,
          costSnapshot
        });

        // Stock deduction is inside the same transaction.
        await client.query(
          isPackage
            ? `UPDATE packages
               SET stock = stock - $1,
                   updated_at = NOW()
               WHERE id = $2`
            : `UPDATE products
               SET stock = stock - $1,
                   updated_at = NOW()
               WHERE id = $2`,
          [quantity, item.id]
        );
      }

      const totalAmount = totalCents / 100;

      if (
        totalCents <= 0 ||
        Math.round(Number(payment.amount) * 100) !== totalCents
      ) {
        throw Object.assign(
          new Error(
            "Order price has changed. Payment requires manual review."
          ),
          { statusCode: 409 }
        );
      }

      // All requests store their order amount in BDT.
      if (payment.currency !== "BDT") {
        throw Object.assign(
          new Error(
            "Invalid payment currency. Manual review required."
          ),
          { statusCode: 409 }
        );
      }

      // USDT: validate saved BEP20 destination and expected amount.
      if (gateway === "usdt_bep20") {
        const settingsResult = await client.query(
          `SELECT
            enabled,
            wallet_address,
            network,
            usdt_rate
           FROM payment_gateway_settings
           WHERE gateway = 'usdt_bep20'
           FOR UPDATE`
        );

        if (!settingsResult.rows.length) {
          throw Object.assign(
            new Error("USDT payment settings not found."),
            { statusCode: 400 }
          );
        }

        const settings = settingsResult.rows[0];

        if (
          settings.network !== "BEP20" ||
          !settings.wallet_address ||
          !checkoutData.walletAddress ||
          settings.wallet_address.toLowerCase() !==
            String(checkoutData.walletAddress).toLowerCase()
        ) {
          throw Object.assign(
            new Error(
              "USDT wallet configuration has changed. Manual review required."
            ),
            { statusCode: 409 }
          );
        }

        const expectedUsdt = Number(checkoutData.expectedUsdt);
        const savedExpectedUsdt = Number(payment.expected_usdt);

        if (
          !Number.isFinite(expectedUsdt) ||
          expectedUsdt <= 0 ||
          !Number.isFinite(savedExpectedUsdt) ||
          savedExpectedUsdt <= 0 ||
          Math.abs(expectedUsdt - savedExpectedUsdt) > 0.000001
        ) {
          throw Object.assign(
            new Error("Invalid expected USDT amount."),
            { statusCode: 400 }
          );
        }

        /*
         * IMPORTANT:
         * This code does not verify the blockchain transaction.
         * Admin must independently check:
         * - BNB Smart Chain (BEP20)
         * - Correct USDT token contract
         * - Correct recipient address
         * - Exact amount
         * - Successful transaction
         * - Sufficient confirmations
         */
      }

      const orderNumber = makeOrderNumber();

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
        VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, 'paid')
        RETURNING *`,
        [
          payment.user_id,
          orderNumber,
          totalAmount.toFixed(2),
          shipping.shippingName,
          shipping.shippingPhone,
          shipping.shippingAddress,
          gateway
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
            subtotal,
            cost_snapshot
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            order.id,
            item.productId,
            item.packageId,
            item.type,
            item.productName,
            item.unitPrice.toFixed(2),
            item.quantity,
            item.subtotal.toFixed(2),
            JSON.stringify(item.costSnapshot)
          ]
        );
      }

      let adminNote = cleanText(req.body.adminNote, 1000);

      if (gateway === "usdt_bep20" && adminNote.length < 5) {
        throw Object.assign(
          new Error(
            "For USDT approval, enter an Admin note confirming manual blockchain verification."
          ),
          { statusCode: 400 }
        );
      }

      if (!adminNote) {
        adminNote = "Payment manually verified by Admin.";
      }

      const updatedPayment = await client.query(
        `UPDATE payment_requests
         SET status = 'approved',
             admin_note = $1,
             verified_by = $2,
             verified_at = NOW(),
             order_id = $3,
             updated_at = NOW()
         WHERE id = $4
           AND status = 'pending'
         RETURNING *`,
        [
          adminNote,
          req.auth.id,
          order.id,
          payment.id
        ]
      );

      if (!updatedPayment.rows.length) {
        throw Object.assign(
          new Error("Payment request could not be approved."),
          { statusCode: 409 }
        );
      }

      await client.query("COMMIT");
      transactionStarted = false;

      return res.json({
        success: true,
        message: "Payment approved and order created.",
        payment: updatedPayment.rows[0],
        order: {
          id: order.id,
          order_number: order.order_number,
          total_amount: order.total_amount,
          payment_method: gateway,
          payment_status: "paid",
          status: order.status,
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
  }
);


// =========================================================
// ADMIN: REJECT PAYMENT
// PATCH /api/payment/admin/requests/:id/reject
// =========================================================

router.patch(
  "/admin/requests/:id/reject",
  async (req, res, next) => {
    try {
      if (!validId(req.params.id)) {
        return sendError(
          res,
          400,
          "Invalid payment request ID."
        );
      }

      const adminNote = cleanText(
        req.body.adminNote,
        1000
      );

      if (adminNote.length < 3) {
        return sendError(
          res,
          400,
          "Please provide a rejection reason."
        );
      }

      const result = await pool.query(
        `UPDATE payment_requests
         SET status = 'rejected',
             admin_note = $1,
             verified_by = $2,
             verified_at = NOW(),
             updated_at = NOW()
         WHERE id = $3
           AND status = 'pending'
         RETURNING
           id,
           payment_reference,
           status,
           admin_note,
           verified_at`,
        [
          adminNote,
          req.auth.id,
          req.params.id
        ]
      );

      if (!result.rows.length) {
        return sendError(
          res,
          404,
          "Pending payment request not found."
        );
      }

      return res.json({
        success: true,
        message: "Payment request rejected.",
        payment: result.rows[0]
      });

    } catch (error) {
      next(error);
    }
  }
);


// =========================================================
// ADMIN: VIEW GATEWAY SETTINGS
// GET /api/payment/admin/settings
// =========================================================

router.get(
  "/admin/settings",
  async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT
          gateway,
          enabled,
          display_name,
          instructions,
          account_number,
          wallet_address,
          network,
          usdt_rate,
          updated_at
         FROM payment_gateway_settings
         ORDER BY gateway`
      );

      return res.json({
        success: true,
        settings: result.rows
      });

    } catch (error) {
      next(error);
    }
  }
);


// =========================================================
// ADMIN: UPDATE GATEWAY SETTINGS
// PUT /api/payment/admin/settings/:gateway
// =========================================================

router.put(
  "/admin/settings/:gateway",
  async (req, res, next) => {
    try {
      const gateway = String(
        req.params.gateway || ""
      ).toLowerCase().trim();

      if (!GATEWAYS[gateway]) {
        return sendError(
          res,
          400,
          "Invalid payment gateway."
        );
      }

      const enabled = req.body.enabled === true;

      const displayName = cleanText(
        req.body.displayName || GATEWAYS[gateway].name,
        100
      );

      if (!displayName) {
        return sendError(
          res,
          400,
          "Display name is required."
        );
      }

      const instructions = cleanText(
        req.body.instructions,
        2000
      );

      const accountNumber = cleanText(
        req.body.accountNumber,
        100
      );

      let walletAddress = null;
      let network = null;
      let usdtRate = null;

      if (gateway === "usdt_bep20") {
        walletAddress = cleanText(
          req.body.walletAddress,
          150
        );

        network = String(
          req.body.network || ""
        ).toUpperCase().trim();

        usdtRate = Number(req.body.usdtRate);

        if (
          enabled &&
          (
            !/^0x[a-fA-F0-9]{40}$/.test(walletAddress) ||
            network !== "BEP20" ||
            !Number.isFinite(usdtRate) ||
            usdtRate <= 0 ||
            usdtRate > 10000000
          )
        ) {
          return sendError(
            res,
            400,
            "To enable USDT, provide a valid BEP20 wallet address, BEP20 network and valid USDT exchange rate."
          );
        }

        if (!walletAddress) walletAddress = null;
        if (network !== "BEP20") network = null;

        if (
          !Number.isFinite(usdtRate) ||
          usdtRate <= 0
        ) {
          usdtRate = null;
        }

      } else if (
        enabled &&
        accountNumber.length < 5
      ) {
        return sendError(
          res,
          400,
          "Please provide a valid payment account number."
        );
      }

      const result = await pool.query(
        `INSERT INTO payment_gateway_settings (
          gateway,
          enabled,
          display_name,
          instructions,
          account_number,
          wallet_address,
          network,
          usdt_rate,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())

        ON CONFLICT (gateway)
        DO UPDATE SET
          enabled = EXCLUDED.enabled,
          display_name = EXCLUDED.display_name,
          instructions = EXCLUDED.instructions,

          account_number = CASE
            WHEN EXCLUDED.account_number IS NOT NULL
              AND EXCLUDED.account_number <> ''
            THEN EXCLUDED.account_number
            ELSE payment_gateway_settings.account_number
          END,

          wallet_address = CASE
            WHEN EXCLUDED.wallet_address IS NOT NULL
              AND EXCLUDED.wallet_address <> ''
            THEN EXCLUDED.wallet_address
            ELSE payment_gateway_settings.wallet_address
          END,

          network = CASE
            WHEN EXCLUDED.network IS NOT NULL
            THEN EXCLUDED.network
            ELSE payment_gateway_settings.network
          END,

          usdt_rate = CASE
            WHEN EXCLUDED.usdt_rate IS NOT NULL
            THEN EXCLUDED.usdt_rate
            ELSE payment_gateway_settings.usdt_rate
          END,

          updated_at = NOW()

        RETURNING
          gateway,
          enabled,
          display_name,
          instructions,
          account_number,
          wallet_address,
          network,
          usdt_rate,
          updated_at`,
        [
          gateway,
          enabled,
          displayName,
          instructions,
          accountNumber || null,
          walletAddress,
          network,
          usdtRate
        ]
      );

      return res.json({
        success: true,
        message: "Payment gateway settings saved.",
        settings: result.rows[0]
      });

    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
