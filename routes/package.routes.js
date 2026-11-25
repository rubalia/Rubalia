
"use strict";

const express = require("express");

const pool = require("../config/database");
const { authenticateToken } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/admin");

const router = express.Router();

const PACKAGE_STATUSES = [
  "draft",
  "active",
  "inactive",
  "archived"
];

const MAX_PRODUCTS_PER_PACKAGE = 3;

/* =========================================================
   HELPERS
========================================================= */

function isPositiveId(value) {
  return (
    Number.isSafeInteger(Number(value)) &&
    Number(value) > 0
  );
}

function parseMoney(value, label) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return {
      valid: false,
      message: `${label} is required.`
    };
  }

  const raw = String(value).trim();

  if (!/^\d{1,12}(\.\d{1,2})?$/.test(raw)) {
    return {
      valid: false,
      message: `${label} must be a valid non-negative amount with up to 2 decimal places.`
    };
  }

  const amount = Number(raw);

  if (!Number.isFinite(amount) || amount < 0) {
    return {
      valid: false,
      message: `${label} cannot be negative.`
    };
  }

  return {
    valid: true,
    value: amount.toFixed(2)
  };
}

function getCostValue(data, camelName, snakeName) {
  if (
    Object.prototype.hasOwnProperty.call(data, camelName)
  ) {
    return data[camelName];
  }

  if (
    Object.prototype.hasOwnProperty.call(data, snakeName)
  ) {
    return data[snakeName];
  }

  return 0;
}

/*
 * Supports both formats:
 *
 * productIds: [1, 2, 3]
 *
 * OR legacy format:
 *
 * product1Id: 1
 * product2Id: 2
 * product3Id: 3
 *
 * Empty optional product fields are ignored.
 */
function getProductIds(data) {
  let rawIds = [];

  if (Array.isArray(data.productIds)) {
    rawIds = data.productIds;
  } else {
    rawIds = [
      data.product1Id ?? data.product_1_id,
      data.product2Id ?? data.product_2_id,
      data.product3Id ?? data.product_3_id
    ];
  }

  const productIds = rawIds
    .filter(value =>
      value !== undefined &&
      value !== null &&
      String(value).trim() !== ""
    )
    .map(Number);

  return productIds;
}

/* =========================================================
   PACKAGE VALIDATION
========================================================= */

function validatePackage(data) {
  const name = String(data.name || "").trim();
  const category = String(data.category || "").trim();
  const description = String(data.description || "").trim();

  const productIds = getProductIds(data);

  const priceRaw = String(data.price ?? "").trim();
  const price = Number(priceRaw);

  const stock = Number(data.stock ?? 0);

  if (name.length < 2 || name.length > 180) {
    return {
      error: "Package name must be 2 to 180 characters."
    };
  }

  if (category.length > 100) {
    return {
      error: "Category must not exceed 100 characters."
    };
  }

  if (description.length > 5000) {
    return {
      error: "Description must not exceed 5000 characters."
    };
  }

  /* At least one and maximum three products */

  if (
    productIds.length < 1 ||
    productIds.length > MAX_PRODUCTS_PER_PACKAGE
  ) {
    return {
      error: "A package must contain at least one and at most three products."
    };
  }

  if (!productIds.every(isPositiveId)) {
    return {
      error: "Select valid products."
    };
  }

  if (new Set(productIds).size !== productIds.length) {
    return {
      error: "The same product cannot be selected more than once."
    };
  }

  if (
    !/^\d{1,12}(\.\d{1,2})?$/.test(priceRaw) ||
    !Number.isFinite(price) ||
    price < 0
  ) {
    return {
      error: "Enter a valid package price."
    };
  }

  if (
    !Number.isSafeInteger(stock) ||
    stock < 0 ||
    stock > 2147483647
  ) {
    return {
      error: "Enter a valid package stock quantity."
    };
  }

  const imageUrl = String(data.imageUrl || "").trim();

  if (imageUrl.length > 2000) {
    return {
      error: "Image URL is too long."
    };
  }

  if (
    imageUrl &&
    !/^https?:\/\/\S+$/i.test(imageUrl)
  ) {
    return {
      error: "Enter a valid HTTP or HTTPS image URL."
    };
  }

  const delivery = parseMoney(
    getCostValue(data, "deliveryCost", "delivery_cost"),
    "Package Delivery Cost"
  );

  if (!delivery.valid) {
    return { error: delivery.message };
  }

  const packaging = parseMoney(
    getCostValue(data, "packagingCost", "packaging_cost"),
    "Package Packaging Cost"
  );

  if (!packaging.valid) {
    return { error: packaging.message };
  }

  const other = parseMoney(
    getCostValue(data, "otherCost", "other_cost"),
    "Package Other Cost"
  );

  if (!other.valid) {
    return { error: other.message };
  }

  return {
    value: {
      name,
      category,
      description,
      imageUrl: imageUrl || null,
      productIds,
      price: price.toFixed(2),
      stock,
      deliveryCost: delivery.value,
      packagingCost: packaging.value,
      otherCost: other.value
    }
  };
}

/* =========================================================
   CHECK PRODUCTS
========================================================= */

async function checkProducts(productIds, client = pool) {
  if (!Array.isArray(productIds) || productIds.length < 1) {
    return false;
  }

  const result = await client.query(
    `SELECT id
     FROM products
     WHERE id = ANY($1::bigint[])
       AND status = 'active'`,
    [productIds]
  );

  return result.rows.length === productIds.length;
}

/* =========================================================
   PACKAGE SELECT
========================================================= */

/*
 * LEFT JOIN is important.
 *
 * Old INNER JOIN required all three products.
 * LEFT JOIN allows packages containing only one or two products.
 *
 * Old packages containing three products continue to work.
 */

const PACKAGE_SELECT = `
  SELECT
    pa.id,
    pa.name,
    pa.category,
    pa.description,
    pa.image_url,
    pa.price,
    pa.stock,
    pa.status,
    pa.delivery_cost,
    pa.packaging_cost,
    pa.other_cost,
    pa.created_at,
    pa.updated_at,

    p1.id AS product_1_id,
    p1.name AS product_1_name,
    p1.sku AS product_1_sku,
    p1.description AS product_1_description,
    p1.price AS product_1_price,
    p1.cost_price AS product_1_cost_price,

    p2.id AS product_2_id,
    p2.name AS product_2_name,
    p2.sku AS product_2_sku,
    p2.description AS product_2_description,
    p2.price AS product_2_price,
    p2.cost_price AS product_2_cost_price,

    p3.id AS product_3_id,
    p3.name AS product_3_name,
    p3.sku AS product_3_sku,
    p3.description AS product_3_description,
    p3.price AS product_3_price,
    p3.cost_price AS product_3_cost_price

  FROM packages pa

  LEFT JOIN products p1
    ON p1.id = pa.product_1_id

  LEFT JOIN products p2
    ON p2.id = pa.product_2_id

  LEFT JOIN products p3
    ON p3.id = pa.product_3_id
`;

/* =========================================================
   FORMAT PACKAGE
========================================================= */

function formatPackage(row, includeCosts = false) {
  const productRows = [
    {
      id: row.product_1_id,
      name: row.product_1_name,
      sku: row.product_1_sku,
      description: row.product_1_description,
      price: row.product_1_price,
      costPrice: row.product_1_cost_price
    },
    {
      id: row.product_2_id,
      name: row.product_2_name,
      sku: row.product_2_sku,
      description: row.product_2_description,
      price: row.product_2_price,
      costPrice: row.product_2_cost_price
    },
    {
      id: row.product_3_id,
      name: row.product_3_name,
      sku: row.product_3_sku,
      description: row.product_3_description,
      price: row.product_3_price,
      costPrice: row.product_3_cost_price
    }
  ];

  const selectedProducts = productRows
    .filter(product =>
      product.id !== null &&
      product.id !== undefined
    );

  const formatted = {
    id: row.id,
    name: row.name,
    category: row.category,
    description: row.description,
    image_url: row.image_url,
    price: Number(row.price),
    stock: row.stock,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,

    products: selectedProducts.map(product => ({
      id: product.id,
      name: product.name,
      sku: product.sku,
      description: product.description,
      price: Number(product.price || 0)
    }))
  };

  if (includeCosts) {
    const productCosts = selectedProducts.map(product =>
      Number(product.costPrice || 0)
    );

    const componentProductCost = productCosts.reduce(
      (sum, cost) => sum + cost,
      0
    );

    const deliveryCost = Number(row.delivery_cost || 0);
    const packagingCost = Number(row.packaging_cost || 0);
    const otherCost = Number(row.other_cost || 0);

    const totalCost =
      componentProductCost +
      deliveryCost +
      packagingCost +
      otherCost;

    formatted.costs = {
      products: selectedProducts.map(product => ({
        productId: product.id,
        productName: product.name,
        costPrice: Number(product.costPrice || 0)
      })),

      componentProductCost,

      deliveryCost,
      packagingCost,
      otherCost,

      totalCost,

      estimatedProfit:
        Number(row.price || 0) - totalCost
    };
  }

  return formatted;
}

/* =========================================================
   PUBLIC: GET ALL ACTIVE PACKAGES
   GET /api/packages
========================================================= */

router.get("/", async (req, res, next) => {
  try {
    const result = await pool.query(
      `${PACKAGE_SELECT}
       WHERE pa.status = 'active'
         AND p1.status = 'active'
         AND (
           pa.product_2_id IS NULL
           OR p2.status = 'active'
         )
         AND (
           pa.product_3_id IS NULL
           OR p3.status = 'active'
         )
       ORDER BY pa.created_at DESC`
    );

    return res.json({
      success: true,
      packages: result.rows.map(row =>
        formatPackage(row, false)
      )
    });
  } catch (error) {
    next(error);
  }
});

/* =========================================================
   PUBLIC: GET SINGLE PACKAGE
   GET /api/packages/:id
========================================================= */

router.get("/:id", async (req, res, next) => {
  try {
    if (!isPositiveId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid package ID."
      });
    }

    const result = await pool.query(
      `${PACKAGE_SELECT}
       WHERE pa.id = $1
         AND pa.status = 'active'
         AND p1.status = 'active'
         AND (
           pa.product_2_id IS NULL
           OR p2.status = 'active'
         )
         AND (
           pa.product_3_id IS NULL
           OR p3.status = 'active'
         )`,
      [Number(req.params.id)]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Package not found."
      });
    }

    return res.json({
      success: true,
      package: formatPackage(result.rows[0], false)
    });
  } catch (error) {
    next(error);
  }
});

/* =========================================================
   ADMIN: GET ALL PACKAGES
   GET /api/packages/admin/all
========================================================= */

router.get(
  "/admin/all",
  authenticateToken,
  requireAdmin,
  async (req, res, next) => {
    try {
      const result = await pool.query(
        `${PACKAGE_SELECT}
         ORDER BY pa.created_at DESC`
      );

      return res.json({
        success: true,
        packages: result.rows.map(row =>
          formatPackage(row, true)
        )
      });
    } catch (error) {
      next(error);
    }
  }
);

/* =========================================================
   ADMIN: CREATE PACKAGE
   POST /api/packages
========================================================= */

router.post(
  "/",
  authenticateToken,
  requireAdmin,
  async (req, res, next) => {
    const client = await pool.connect();

    let transactionStarted = false;

    try {
      const validation = validatePackage(req.body || {});

      if (validation.error) {
        return res.status(400).json({
          success: false,
          message: validation.error
        });
      }

      const data = validation.value;

      await client.query("BEGIN");
      transactionStarted = true;

      const productsValid = await checkProducts(
        data.productIds,
        client
      );

      if (!productsValid) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(400).json({
          success: false,
          message: "All selected products must exist and be active."
        });
      }

      const product1Id = data.productIds[0] || null;
      const product2Id = data.productIds[1] || null;
      const product3Id = data.productIds[2] || null;

      const result = await client.query(
        `INSERT INTO packages (
           name,
           category,
           description,
           image_url,
           product_1_id,
           product_2_id,
           product_3_id,
           price,
           stock,
           status,
           delivery_cost,
           packaging_cost,
           other_cost
         )
         VALUES (
           $1, $2, $3, $4,
           $5, $6, $7,
           $8, $9, 'draft',
           $10, $11, $12
         )
         RETURNING
           id,
           name,
           status,
           delivery_cost,
           packaging_cost,
           other_cost`,
        [
          data.name,
          data.category || null,
          data.description || null,
          data.imageUrl,
          product1Id,
          product2Id,
          product3Id,
          data.price,
          data.stock,
          data.deliveryCost,
          data.packagingCost,
          data.otherCost
        ]
      );

      await client.query("COMMIT");
      transactionStarted = false;

      return res.status(201).json({
        success: true,
        message: "Package created successfully as draft.",
        package: result.rows[0]
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

/* =========================================================
   ADMIN: UPDATE PACKAGE
   PUT /api/packages/:id
========================================================= */

router.put(
  "/:id",
  authenticateToken,
  requireAdmin,
  async (req, res, next) => {
    const client = await pool.connect();

    let transactionStarted = false;

    try {
      if (!isPositiveId(req.params.id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid package ID."
        });
      }

      const validation = validatePackage(req.body || {});

      if (validation.error) {
        return res.status(400).json({
          success: false,
          message: validation.error
        });
      }

      const data = validation.value;
      const packageId = Number(req.params.id);

      await client.query("BEGIN");
      transactionStarted = true;

      const productsValid = await checkProducts(
        data.productIds,
        client
      );

      if (!productsValid) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(400).json({
          success: false,
          message: "All selected products must exist and be active."
        });
      }

      const product1Id = data.productIds[0] || null;
      const product2Id = data.productIds[1] || null;
      const product3Id = data.productIds[2] || null;

      const result = await client.query(
        `UPDATE packages
         SET
           name = $1,
           category = $2,
           description = $3,
           image_url = $4,
           product_1_id = $5,
           product_2_id = $6,
           product_3_id = $7,
           price = $8,
           stock = $9,
           delivery_cost = $10,
           packaging_cost = $11,
           other_cost = $12,
           updated_at = NOW()
         WHERE id = $13
         RETURNING
           id,
           name,
           status,
           delivery_cost,
           packaging_cost,
           other_cost`,
        [
          data.name,
          data.category || null,
          data.description || null,
          data.imageUrl,
          product1Id,
          product2Id,
          product3Id,
          data.price,
          data.stock,
          data.deliveryCost,
          data.packagingCost,
          data.otherCost,
          packageId
        ]
      );

      if (!result.rows.length) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(404).json({
          success: false,
          message: "Package not found."
        });
      }

      await client.query("COMMIT");
      transactionStarted = false;

      return res.json({
        success: true,
        message: "Package and cost information updated successfully.",
        package: result.rows[0]
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

/* =========================================================
   ADMIN: CHANGE PACKAGE STATUS
   PATCH /api/packages/:id/status
========================================================= */

router.patch(
  "/:id/status",
  authenticateToken,
  requireAdmin,
  async (req, res, next) => {
    try {
      if (!isPositiveId(req.params.id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid package ID."
        });
      }

      const status = String(req.body.status || "").trim();

      if (!PACKAGE_STATUSES.includes(status)) {
        return res.status(400).json({
          success: false,
          message: "Invalid package status."
        });
      }

      /*
       * A package cannot be activated if its required
       * first product is missing or inactive.
       */

      if (status === "active") {
        const packageCheck = await pool.query(
          `SELECT
             pa.id,
             p1.status AS product_1_status,
             p2.status AS product_2_status,
             p3.status AS product_3_status
           FROM packages pa
           LEFT JOIN products p1
             ON p1.id = pa.product_1_id
           LEFT JOIN products p2
             ON p2.id = pa.product_2_id
           LEFT JOIN products p3
             ON p3.id = pa.product_3_id
           WHERE pa.id = $1`,
          [Number(req.params.id)]
        );

        if (!packageCheck.rows.length) {
          return res.status(404).json({
            success: false,
            message: "Package not found."
          });
        }

        const item = packageCheck.rows[0];

        if (item.product_1_status !== "active") {
          return res.status(400).json({
            success: false,
            message: "The first product must be active before activating this package."
          });
        }

        if (
          item.product_2_status &&
          item.product_2_status !== "active"
        ) {
          return res.status(400).json({
            success: false,
            message: "The second selected product is not active."
          });
        }

        if (
          item.product_3_status &&
          item.product_3_status !== "active"
        ) {
          return res.status(400).json({
            success: false,
            message: "The third selected product is not active."
          });
        }
      }

      const result = await pool.query(
        `UPDATE packages
         SET
           status = $1,
           updated_at = NOW()
         WHERE id = $2
         RETURNING id, name, status`,
        [status, Number(req.params.id)]
      );

      if (!result.rows.length) {
        return res.status(404).json({
          success: false,
          message: "Package not found."
        });
      }

      return res.json({
        success: true,
        message: "Package status updated.",
        package: result.rows[0]
      });
    } catch (error) {
      next(error);
    }
  }
);

/* =========================================================
   ADMIN: ARCHIVE PACKAGE
   DELETE /api/packages/:id
========================================================= */

router.delete(
  "/:id",
  authenticateToken,
  requireAdmin,
  async (req, res, next) => {
    try {
      if (!isPositiveId(req.params.id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid package ID."
        });
      }

      const result = await pool.query(
        `UPDATE packages
         SET
           status = 'archived',
           updated_at = NOW()
         WHERE id = $1
         RETURNING id, name, status`,
        [Number(req.params.id)]
      );

      if (!result.rows.length) {
        return res.status(404).json({
          success: false,
          message: "Package not found."
        });
      }

      return res.json({
        success: true,
        message: "Package archived successfully.",
        package: result.rows[0]
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
