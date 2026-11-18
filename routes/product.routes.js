const express = require("express");

const pool = require("../config/database");
const { authenticateToken } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/admin");

const router = express.Router();

// GET /api/products
// Public: Show active products.
router.get("/", async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, name, sku, description, price, stock, status, created_at
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

// GET /api/products/:id
// Public: View one active product.
router.get("/:id", async (req, res, next) => {
  try {
    const productId = Number(req.params.id);

    if (!Number.isSafeInteger(productId) || productId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid product ID."
      });
    }

    const result = await pool.query(
      `SELECT id, name, sku, description, price, stock, status, created_at
       FROM products
       WHERE id = $1 AND status = 'active'`,
      [productId]
    );

    if (result.rows.length === 0) {
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

// POST /api/products
// Admin: Create a product.
router.post(
  "/",
  authenticateToken,
  requireAdmin,
  async (req, res, next) => {
    try {
      const { name, sku, description, price, stock, status } = req.body;

      const cleanName = typeof name === "string" ? name.trim() : "";
      const cleanSku = typeof sku === "string" ? sku.trim() : null;
      const cleanDescription =
        typeof description === "string" ? description.trim() : null;

      const productPrice = Number(price);
      const productStock = Number(stock ?? 0);
      const productStatus = status || "draft";

      if (!cleanName || cleanName.length > 180) {
        return res.status(400).json({
          success: false,
          message: "Product name is required (maximum 180 characters)."
        });
      }

      if (
        !Number.isFinite(productPrice) ||
        productPrice < 0 ||
        !Number.isInteger(productStock) ||
        productStock < 0
      ) {
        return res.status(400).json({
          success: false,
          message: "Price and stock values are invalid."
        });
      }

      if (!["draft", "active", "archived"].includes(productStatus)) {
        return res.status(400).json({
          success: false,
          message: "Invalid product status."
        });
      }

      const result = await pool.query(
        `INSERT INTO products
          (name, sku, description, price, stock, status)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          cleanName,
          cleanSku || null,
          cleanDescription,
          productPrice,
          productStock,
          productStatus
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

// PUT /api/products/:id
// Admin: Update a product.
router.put(
  "/:id",
  authenticateToken,
  requireAdmin,
  async (req, res, next) => {
    try {
      const productId = Number(req.params.id);

      if (!Number.isSafeInteger(productId) || productId <= 0) {
        return res.status(400).json({
          success: false,
          message: "Invalid product ID."
        });
      }

      const { name, sku, description, price, stock, status } = req.body;

      const cleanName = typeof name === "string" ? name.trim() : "";
      const cleanSku = typeof sku === "string" ? sku.trim() : null;
      const cleanDescription =
        typeof description === "string" ? description.trim() : null;

      const productPrice = Number(price);
      const productStock = Number(stock);

      if (!cleanName || cleanName.length > 180) {
        return res.status(400).json({
          success: false,
          message: "Product name is required (maximum 180 characters)."
        });
      }

      if (
        !Number.isFinite(productPrice) ||
        productPrice < 0 ||
        !Number.isInteger(productStock) ||
        productStock < 0
      ) {
        return res.status(400).json({
          success: false,
          message: "Price and stock values are invalid."
        });
      }

      if (!["draft", "active", "archived"].includes(status)) {
        return res.status(400).json({
          success: false,
          message: "Invalid product status."
        });
      }

      const result = await pool.query(
        `UPDATE products
         SET name = $1,
             sku = $2,
             description = $3,
             price = $4,
             stock = $5,
             status = $6,
             updated_at = NOW()
         WHERE id = $7
         RETURNING *`,
        [
          cleanName,
          cleanSku || null,
          cleanDescription,
          productPrice,
          productStock,
          status,
          productId
        ]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Product not found."
        });
      }

      return res.json({
        success: true,
        message: "Product updated successfully.",
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

// DELETE /api/products/:id
// Admin: Archive a product instead of permanently deleting it.
router.delete(
  "/:id",
  authenticateToken,
  requireAdmin,
  async (req, res, next) => {
    try {
      const productId = Number(req.params.id);

      if (!Number.isSafeInteger(productId) || productId <= 0) {
        return res.status(400).json({
          success: false,
          message: "Invalid product ID."
        });
      }

      const result = await pool.query(
        `UPDATE products
         SET status = 'archived',
             updated_at = NOW()
         WHERE id = $1
         RETURNING id, name, status`,
        [productId]
      );

      if (result.rows.length === 0) {
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
