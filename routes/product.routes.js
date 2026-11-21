
"use strict";

const express = require("express");

const pool = require("../config/database");
const { authenticateToken } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/admin");

const router = express.Router();

const PRODUCT_STATUSES = ["draft", "active", "archived"];

function validateProductId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// =====================================================
// MONEY VALIDATION
// =====================================================

function parseMoney(value, fieldName) {
  if (value === undefined || value === null || value === "") {
    return {
      valid: false,
      message: `${fieldName} is required.`
    };
  }

  const raw = String(value).trim();

  if (!/^\d{1,12}(\.\d{1,2})?$/.test(raw)) {
    return {
      valid: false,
      message: `${fieldName} must be a valid non-negative amount with up to 2 decimal places.`
    };
  }

  const amount = Number(raw);

  if (!Number.isFinite(amount) || amount < 0) {
    return {
      valid: false,
      message: `${fieldName} cannot be negative.`
    };
  }

  return {
    valid: true,
    value: amount.toFixed(2)
  };
}

function getCostValue(body, camelName, snakeName) {
  if (Object.prototype.hasOwnProperty.call(body, camelName)) {
    return body[camelName];
  }

  if (Object.prototype.hasOwnProperty.call(body, snakeName)) {
    return body[snakeName];
  }

  return 0;
}

function validateCosts(body) {
  const definitions = [
    ["costPrice", "cost_price", "Cost Price"],
    ["deliveryCost", "delivery_cost", "Delivery Cost"],
    ["packagingCost", "packaging_cost", "Packaging Cost"],
    ["otherCost", "other_cost", "Other Cost"]
  ];

  const result = {};

  for (const [camelName, snakeName, label] of definitions) {
    const parsed = parseMoney(
      getCostValue(body, camelName, snakeName),
      label
    );

    if (!parsed.valid) {
      return {
        valid: false,
        message: parsed.message
      };
    }

    result[snakeName] = parsed.value;
  }

  return {
    valid: true,
    values: result
  };
}

// =====================================================
// PRODUCT DATA VALIDATION
// =====================================================

function validateProductData(body) {
  const name =
    typeof body.name === "string"
      ? body.name.trim()
      : "";

  const sku =
    typeof body.sku === "string"
      ? body.sku.trim()
      : null;

  const description =
    typeof body.description === "string"
      ? body.description.trim()
      : null;

  const priceRaw = String(body.price ?? "").trim();
  const price = Number(priceRaw);

  const stock =
    body.stock === undefined
      ? 0
      : Number(body.stock);

  const status =
    body.status === undefined
      ? "draft"
      : body.status;

  if (!name || name.length > 180) {
    return {
      valid: false,
      message: "Product name is required (maximum 180 characters)."
    };
  }

  if (sku && sku.length > 100) {
    return {
      valid: false,
      message: "SKU cannot exceed 100 characters."
    };
  }

  if (
    !Number.isFinite(price) ||
    price < 0 ||
    !/^\d{1,12}(\.\d{1,2})?$/.test(priceRaw)
  ) {
    return {
      valid: false,
      message: "Enter a valid product price."
    };
  }

  if (!Number.isSafeInteger(stock) || stock < 0) {
    return {
      valid: false,
      message: "Stock must be a non-negative whole number."
    };
  }

  if (!PRODUCT_STATUSES.includes(status)) {
    return {
      valid: false,
      message: "Invalid product status."
    };
  }

  const costs = validateCosts(body);

  if (!costs.valid) {
    return {
      valid: false,
      message: costs.message
    };
  }

  return {
    valid: true,
    values: {
      name,
      sku: sku || null,
      description: description || null,
      price: price.toFixed(2),
      stock,
      status,
      ...costs.values
    }
  };
}

// =====================================================
// PUBLIC PRODUCT LIST
// GET /api/products
// Cost information is hidden from customers.
// =====================================================

router.get("/", async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT
         id,
         name,
         sku,
         description,
         price,
         stock,
         status,
         created_at
       FROM products
       WHERE status = 'active'
       ORDER BY created_at DESC`
    );

    return res.json({
      success: true,
      products: result.rows
    });

  } catch (error) {
    next(error);
  }
});

// =====================================================
// ADMIN PRODUCT LIST
// GET /api/products/admin/all
// =====================================================

router.get(
  "/admin/all",
  authenticateToken,
  requireAdmin,
  async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT
           id,
           name,
           sku,
           description,
           price,
           stock,
           status,
           cost_price,
           delivery_cost,
           packaging_cost,
           other_cost,
           created_at,
           updated_at
         FROM products
         ORDER BY created_at DESC`
      );

      return res.json({
        success: true,
        products: result.rows
      });

    } catch (error) {
      next(error);
    }
  }
);

// =====================================================
// PUBLIC SINGLE PRODUCT
// GET /api/products/:id
// =====================================================

router.get("/:id", async (req, res, next) => {
  try {
    const productId = validateProductId(req.params.id);

    if (!productId) {
      return res.status(400).json({
        success: false,
        message: "Invalid product ID."
      });
    }

    const result = await pool.query(
      `SELECT
         id,
         name,
         sku,
         description,
         price,
         stock,
         status,
         created_at
       FROM products
       WHERE id = $1
         AND status = 'active'`,
      [productId]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Product not found."
      });
    }

    return res.json({
      success: true,
      product: result.rows[0]
    });

  } catch (error) {
    next(error);
  }
});

// =====================================================
// CREATE PRODUCT
// POST /api/products
// =====================================================

router.post(
  "/",
  authenticateToken,
  requireAdmin,
  async (req, res, next) => {
    try {
      const validation = validateProductData(req.body || {});

      if (!validation.valid) {
        return res.status(400).json({
          success: false,
          message: validation.message
        });
      }

      const p = validation.values;

      const result = await pool.query(
        `INSERT INTO products (
           name,
           sku,
           description,
           price,
           stock,
           status,
           cost_price,
           delivery_cost,
           packaging_cost,
           other_cost
         )
         VALUES (
           $1, $2, $3, $4, $5,
           $6, $7, $8, $9, $10
         )
         RETURNING
           id,
           name,
           sku,
           description,
           price,
           stock,
           status,
           cost_price,
           delivery_cost,
           packaging_cost,
           other_cost,
           created_at,
           updated_at`,
        [
          p.name,
          p.sku,
          p.description,
          p.price,
          p.stock,
          p.status,
          p.cost_price,
          p.delivery_cost,
          p.packaging_cost,
          p.other_cost
        ]
      );

      return res.status(201).json({
        success: true,
        message: "Product created successfully.",
        product: result.rows[0]
      });

    } catch (error) {
      if (error.code === "23505") {
        return res.status(409).json({
          success: false,
          message: "This product SKU already exists."
        });
      }

      next(error);
    }
  }
);

// =====================================================
// UPDATE PRODUCT
// PUT /api/products/:id
// Existing order snapshots remain unchanged.
// =====================================================

router.put(
  "/:id",
  authenticateToken,
  requireAdmin,
  async (req, res, next) => {
    try {
      const productId = validateProductId(req.params.id);

      if (!productId) {
        return res.status(400).json({
          success: false,
          message: "Invalid product ID."
        });
      }

      const validation = validateProductData(req.body || {});

      if (!validation.valid) {
        return res.status(400).json({
          success: false,
          message: validation.message
        });
      }

      const p = validation.values;

      const result = await pool.query(
        `UPDATE products
         SET
           name = $1,
           sku = $2,
           description = $3,
           price = $4,
           stock = $5,
           status = $6,
           cost_price = $7,
           delivery_cost = $8,
           packaging_cost = $9,
           other_cost = $10,
           updated_at = NOW()
         WHERE id = $11
         RETURNING
           id,
           name,
           sku,
           description,
           price,
           stock,
           status,
           cost_price,
           delivery_cost,
           packaging_cost,
           other_cost,
           created_at,
           updated_at`,
        [
          p.name,
          p.sku,
          p.description,
          p.price,
          p.stock,
          p.status,
          p.cost_price,
          p.delivery_cost,
          p.packaging_cost,
          p.other_cost,
          productId
        ]
      );

      if (!result.rows.length) {
        return res.status(404).json({
          success: false,
          message: "Product not found."
        });
      }

      return res.json({
        success: true,
        message: "Product and cost information updated successfully.",
        product: result.rows[0]
      });

    } catch (error) {
      if (error.code === "23505") {
        return res.status(409).json({
          success: false,
          message: "This product SKU already exists."
        });
      }

      next(error);
    }
  }
);

// =====================================================
// ARCHIVE PRODUCT
// DELETE /api/products/:id
// Product is archived, not permanently deleted.
// =====================================================

router.delete(
  "/:id",
  authenticateToken,
  requireAdmin,
  async (req, res, next) => {
    try {
      const productId = validateProductId(req.params.id);

      if (!productId) {
        return res.status(400).json({
          success: false,
          message: "Invalid product ID."
        });
      }

      const result = await pool.query(
        `UPDATE products
         SET
           status = 'archived',
           updated_at = NOW()
         WHERE id = $1
         RETURNING id, name, status`,
        [productId]
      );

      if (!result.rows.length) {
        return res.status(404).json({
          success: false,
          message: "Product not found."
        });
      }

      return res.json({
        success: true,
        message: "Product archived successfully.",
        product: result.rows[0]
      });

    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
