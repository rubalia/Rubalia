
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

function validatePackage(data) {
  const name = String(data.name || "").trim();
  const category = String(data.category || "").trim();
  const description = String(data.description || "").trim();

  const productIds = [
    Number(data.product1Id ?? data.product_1_id),
    Number(data.product2Id ?? data.product_2_id),
    Number(data.product3Id ?? data.product_3_id)
  ];

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

  if (!productIds.every(isPositiveId)) {
    return {
      error: "Select exactly three valid products."
    };
  }

  if (new Set(productIds).size !== 3) {
    return {
      error: "A package must contain three different products."
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

async function checkProducts(productIds, client = pool) {
  const result = await client.query(
    `SELECT id
     FROM products
     WHERE id = ANY($1::int[])
       AND status = 'active'`,
    [productIds]
  );

  return result.rows.length === 3;
}

/**
 * Shared package query.
 *
 * Product actual cost and package extra costs are selected
 * for internal Admin cost reporting.
 * Public response formatting removes these fields.
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
  JOIN products p1 ON p1.id = pa.product_1_id
  JOIN products p2 ON p2.id = pa.product_2_id
  JOIN products p3 ON p3.id = pa.product_3_id
`;

function formatPackage(row, includeCosts = false) {
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

    products: [
      {
        id: row.product_1_id,
        name: row.product_1_name,
        sku: row.product_1_sku,
        description: row.product_1_description,
        price: Number(row.product_1_price)
      },
      {
        id: row.product_2_id,
        name: row.product_2_name,
        sku: row.product_2_sku,
        description: row.product_2_description,
        price: Number(row.product_2_price)
      },
      {
        id: row.product_3_id,
        name: row.product_3_name,
        sku: row.product_3_sku,
        description: row.product_3_description,
        price: Number(row.product_3_price)
      }
    ]
  };

  if (includeCosts) {
    const productCosts = [
      Number(row.product_1_cost_price || 0),
      Number(row.product_2_cost_price || 0),
      Number(row.product_3_cost_price || 0)
    ];

    const componentProductCost = productCosts.reduce(
      (sum, cost) => sum + cost,
      0
    );

    const deliveryCost = Number(row.delivery_cost || 0);
    const packagingCost = Number(row.packaging_cost || 0);
    const otherCost = Number(row.other_cost || 0);

    formatted.costs = {
      products: [
        {
          productId: row.product_1_id,
          productName: row.product_1_name,
          costPrice: productCosts[0]
        },
        {
          productId: row.product_2_id,
          productName: row.product_2_name,
          costPrice: productCosts[1]
        },
        {
          productId: row.product_3_id,
          productName: row.product_3_name,
          costPrice: productCosts[2]
        }
      ],

      componentProductCost,

      deliveryCost,
      packagingCost,
      otherCost,

      totalCost:
        componentProductCost +
        deliveryCost +
        packagingCost +
        otherCost,

      estimatedProfit:
        Number(row.price) -
        (
          componentProductCost +
          deliveryCost +
          packagingCost +
          otherCost
        )
    };
  }

  return formatted;
}

/**
 * PUBLIC
 * GET /api/packages
 *
 * Cost details are not returned.
 */
router.get("/", async (req, res, next) => {
  try {
    const result = await pool.query(
      `${PACKAGE_SELECT}
       WHERE pa.status = 'active'
         AND p1.status = 'active'
         AND p2.status = 'active'
         AND p3.status = 'active'
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

/**
 * PUBLIC
 * GET /api/packages/:id
 */
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
         AND p2.status = 'active'
         AND p3.status = 'active'`,
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

/**
 * ADMIN
 * GET /api/packages/admin/all
 *
 * Includes product cost and package extra cost breakdown.
 */
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

/**
 * ADMIN
 * POST /api/packages
 */
router.post(
  "/",
  authenticateToken,
  requireAdmin,
  async (req, res, next) => {
    const client = await pool.connect();

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

      const productsValid = await checkProducts(
        data.productIds,
        client
      );

      if (!productsValid) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message: "All three selected products must exist and be active."
        });
      }

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
           $1, $2, $3, $4, $5, $6, $7,
           $8, $9, 'draft', $10, $11, $12
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
          data.productIds[0],
          data.productIds[1],
          data.productIds[2],
          data.price,
          data.stock,
          data.deliveryCost,
          data.packagingCost,
          data.otherCost
        ]
      );

      await client.query("COMMIT");

      return res.status(201).json({
        success: true,
        message: "Package created successfully as draft.",
        package: result.rows[0]
      });
    } catch (error) {
      await client.query("ROLLBACK");
      next(error);
    } finally {
      client.release();
    }
  }
);

/**
 * ADMIN
 * PUT /api/packages/:id
 *
 * Updates current package configuration only.
 * Existing order snapshots remain unchanged.
 */
router.put(
  "/:id",
  authenticateToken,
  requireAdmin,
  async (req, res, next) => {
    const client = await pool.connect();

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

      const productsValid = await checkProducts(
        data.productIds,
        client
      );

      if (!productsValid) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message: "All three selected products must exist and be active."
        });
      }

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
          data.productIds[0],
          data.productIds[1],
          data.productIds[2],
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

        return res.status(404).json({
          success: false,
          message: "Package not found."
        });
      }

      await client.query("COMMIT");

      return res.json({
        success: true,
        message: "Package and cost information updated successfully.",
        package: result.rows[0]
      });
    } catch (error) {
      await client.query("ROLLBACK");
      next(error);
    } finally {
      client.release();
    }
  }
);

/**
 * ADMIN
 * PATCH /api/packages/:id/status
 */
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

/**
 * ADMIN
 * DELETE /api/packages/:id
 *
 * Archives package instead of permanently deleting it.
 */
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
