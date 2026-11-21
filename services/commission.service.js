
"use strict";

// =====================================================
// RUBALIA NETWORK
// 10 LEVEL UNILEVEL COMMISSION ENGINE
// =====================================================

const DEFAULT_RATES = [
  20, // Level 1
  15, // Level 2
  10, // Level 3
  8,  // Level 4
  6,  // Level 5
  5,  // Level 6
  4,  // Level 7
  3,  // Level 8
  2,  // Level 9
  2   // Level 10
];

const COMPANY_SHARE_PERCENT = 25;
const TOTAL_COMMISSION_PERCENT = 75;


// Convert money into integer cents.
// Avoid floating-point calculation errors.
function toCents(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    throw new Error("Invalid money value.");
  }

  return Math.round(number * 100);
}


// Convert cents into decimal money string.
function fromCents(value) {
  return (value / 100).toFixed(2);
}


// Validate commission rates.
function validateRates(rates) {
  if (typeof rates === "string") {
    try {
      rates = JSON.parse(rates);
    } catch {
      throw new Error("Invalid commission rate configuration.");
    }
  }

  if (!Array.isArray(rates) || rates.length !== 10) {
    throw new Error("Exactly 10 commission levels are required.");
  }

  const normalized = rates.map(Number);

  if (
    normalized.some(
      rate =>
        !Number.isFinite(rate) ||
        rate < 0 ||
        rate > 75
    )
  ) {
    throw new Error("Invalid commission percentage.");
  }

  const total = normalized.reduce(
    (sum, rate) => sum + rate,
    0
  );

  if (Math.abs(total - TOTAL_COMMISSION_PERCENT) > 0.0001) {
    throw new Error(
      "The total of all 10 commission levels must be exactly 75%."
    );
  }

  return normalized;
}


// =====================================================
// GET ORDER COST AND PROFIT
// =====================================================

async function calculateOrderProfit(client, orderId, gatewayFeePercent) {

  const result = await client.query(
    `
    SELECT
      oi.id,
      oi.item_type,
      oi.product_id,
      oi.package_id,
      oi.quantity,
      oi.subtotal,

      p.cost_price AS product_cost,
      p.delivery_cost AS product_delivery,
      p.packaging_cost AS product_packaging,
      p.other_cost AS product_other,

      pa.delivery_cost AS package_delivery,
      pa.packaging_cost AS package_packaging,
      pa.other_cost AS package_other,

      p1.cost_price AS package_product_1_cost,
      p2.cost_price AS package_product_2_cost,
      p3.cost_price AS package_product_3_cost

    FROM order_items oi

    LEFT JOIN products p
      ON p.id = oi.product_id

    LEFT JOIN packages pa
      ON pa.id = oi.package_id

    LEFT JOIN products p1
      ON p1.id = pa.product_1_id

    LEFT JOIN products p2
      ON p2.id = pa.product_2_id

    LEFT JOIN products p3
      ON p3.id = pa.product_3_id

    WHERE oi.order_id = $1

    ORDER BY oi.id
    `,
    [orderId]
  );

  if (!result.rows.length) {
    throw new Error("Order items not found.");
  }

  let revenueCents = 0;
  let directCostCents = 0;

  for (const item of result.rows) {

    const quantity = Number(item.quantity);

    if (
      !Number.isFinite(quantity) ||
      quantity <= 0
    ) {
      throw new Error("Invalid order quantity.");
    }

    const subtotalCents = toCents(item.subtotal);

    revenueCents += subtotalCents;

    if (item.item_type === "package") {

      const product1Cost = item.package_product_1_cost;
      const product2Cost = item.package_product_2_cost;
      const product3Cost = item.package_product_3_cost;

      if (
        product1Cost === null ||
        product2Cost === null ||
        product3Cost === null
      ) {
        throw new Error(
          "Package product cost information is incomplete."
        );
      }

      const componentCost =
        toCents(product1Cost) +
        toCents(product2Cost) +
        toCents(product3Cost);

      const packageExtraCost =
        toCents(item.package_delivery) +
        toCents(item.package_packaging) +
        toCents(item.package_other);

      directCostCents +=
        (componentCost + packageExtraCost) * quantity;

    } else if (item.item_type === "product") {

      if (item.product_cost === null) {
        throw new Error("Product cost information is missing.");
      }

      const productCost =
        toCents(item.product_cost) +
        toCents(item.product_delivery) +
        toCents(item.product_packaging) +
        toCents(item.product_other);

      directCostCents += productCost * quantity;

    } else {

      throw new Error("Unsupported order item type.");

    }
  }

  const gatewayFeeCents = Math.round(
    revenueCents *
    Number(gatewayFeePercent) /
    100
  );

  const actualProfitCents =
    revenueCents -
    directCostCents -
    gatewayFeeCents;

  if (actualProfitCents <= 0) {
    throw new Error(
      "The order does not have positive net profit. Commission cannot be calculated."
    );
  }

  return {
    revenue: fromCents(revenueCents),
    directCosts: fromCents(directCostCents),
    gatewayFee: fromCents(gatewayFeeCents),
    actualProfit: fromCents(actualProfitCents),
    revenueCents,
    directCostCents,
    gatewayFeeCents,
    actualProfitCents
  };
}


// =====================================================
// GET 10 LEVEL SPONSOR CHAIN
// =====================================================

async function getSponsorChain(client, buyerId) {

  const sponsors = [];

  let currentUserId = buyerId;

  for (let level = 1; level <= 10; level++) {

    const result = await client.query(
      `
      SELECT sponsor_id
      FROM users
      WHERE id = $1
      `,
      [currentUserId]
    );

    const sponsorId =
      result.rows[0]?.sponsor_id || null;

    if (!sponsorId) {
      sponsors.push(null);

      currentUserId = null;

      continue;
    }

    sponsors.push(sponsorId);

    currentUserId = sponsorId;
  }

  return sponsors;
}


// =====================================================
// ADD COMMISSION TO MEMBER WALLET
// =====================================================

async function creditMemberWallet(
  client,
  memberId,
  amount,
  orderId,
  level
) {

  if (amount <= 0) {
    return;
  }

  const walletResult = await client.query(
    `
    INSERT INTO wallets (
      user_id
    )

    VALUES ($1)

    ON CONFLICT (user_id)
    DO UPDATE SET
      user_id = EXCLUDED.user_id

    RETURNING id
    `,
    [memberId]
  );

  const walletId = walletResult.rows[0].id;

  await client.query(
    `
    UPDATE wallets

    SET
      balance = balance + $1,
      updated_at = NOW()

    WHERE id = $2
    `,
    [
      fromCents(amount),
      walletId
    ]
  );

  await client.query(
    `
    INSERT INTO wallet_transactions (
      wallet_id,
      transaction_type,
      amount,
      reference,
      description,
      status
    )

    VALUES (
      $1,
      'commission',
      $2,
      $3,
      $4,
      'completed'
    )
    `,
    [
      walletId,
      fromCents(amount),
      `COM-${orderId}-L${level}`,
      `Level ${level} commission from order ${orderId}`
    ]
  );
}


// =====================================================
// RELEASE COMMISSION FOR A DELIVERED ORDER
//
// IMPORTANT:
// Call this function inside a PostgreSQL transaction.
// =====================================================

async function releaseOrderCommission(
  client,
  orderId
) {

  // 1. Lock commission settings.

  const settingsResult = await client.query(
    `
    SELECT
      enabled,
      legal_approval_confirmed,
      gateway_fee_percent,
      level_rates

    FROM commission_settings

    WHERE id = 1

    FOR UPDATE
    `
  );

  const settings = settingsResult.rows[0];

  if (!settings) {
    throw new Error("Commission settings not found.");
  }

  if (!settings.enabled) {
    throw new Error("Commission engine is disabled.");
  }

  if (!settings.legal_approval_confirmed) {
    throw new Error(
      "Required legal approval has not been confirmed."
    );
  }


  // 2. Validate commission percentages.

  const rates = validateRates(settings.level_rates);


  // 3. Lock order.

  const orderResult = await client.query(
    `
    SELECT
      id,
      user_id,
      order_number,
      total_amount,
      status,
      payment_status,
      payment_method

    FROM orders

    WHERE id = $1

    FOR UPDATE
    `,
    [orderId]
  );

  if (!orderResult.rows.length) {
    throw new Error("Order not found.");
  }

  const order = orderResult.rows[0];


  // 4. Only paid and delivered orders are eligible.

  if (
    order.status !== "delivered" ||
    order.payment_status !== "paid"
  ) {
    throw new Error(
      "Only paid and delivered orders are eligible for commission."
    );
  }


  // 5. Prevent duplicate commission.

  const existingResult = await client.query(
    `
    SELECT id

    FROM company_profit_ledger

    WHERE order_id = $1

    LIMIT 1
    `,
    [orderId]
  );

  if (existingResult.rows.length) {
    throw new Error(
      "Commission has already been processed for this order."
    );
  }


  // 6. Calculate actual order profit.

  const feePercent =
    order.payment_method === "wallet"
      ? 0
      : Number(settings.gateway_fee_percent);

  const profit = await calculateOrderProfit(
    client,
    orderId,
    feePercent
  );

  const profitCents = profit.actualProfitCents;


  // 7. Calculate company share.

  const companyShareCents = Math.round(
    profitCents *
    COMPANY_SHARE_PERCENT /
    100
  );


  // 8. Find all 10 sponsors.

  const sponsorChain = await getSponsorChain(
    client,
    order.user_id
  );


  // 9. Calculate and distribute commissions.

  let allocatedCommissionCents = 0;
  let unallocatedCommissionCents = 0;

  const commissionDetails = [];

  for (let index = 0; index < 10; index++) {

    const level = index + 1;

    const rate = rates[index];

    const sponsorId = sponsorChain[index];

    const amountCents = Math.round(
      profitCents * rate / 100
    );

    if (sponsorId) {

      // Create commission ledger entry.

      const ledgerResult = await client.query(
        `
        INSERT INTO commission_ledger (
          order_id,
          beneficiary_id,
          level,
          rate_percent,
          profit_base,
          amount,
          status
        )

        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          'credited'
        )

        ON CONFLICT (order_id, level)
        DO NOTHING

        RETURNING id
        `,
        [
          orderId,
          sponsorId,
          level,
          rate,
          fromCents(profitCents),
          fromCents(amountCents)
        ]
      );

      // Credit wallet only when ledger insertion succeeded.

      if (ledgerResult.rows.length && amountCents > 0) {

        await creditMemberWallet(
          client,
          sponsorId,
          amountCents,
          orderId,
          level
        );

      }

      if (ledgerResult.rows.length) {
        allocatedCommissionCents += amountCents;
      }

      commissionDetails.push({
        level,
        memberId: sponsorId,
        rate,
        amount: fromCents(amountCents),
        status: "credited"
      });

    } else {

      // No eligible sponsor at this level.
      // Keep the amount with the company.

      await client.query(
        `
        INSERT INTO commission_ledger (
          order_id,
          beneficiary_id,
          level,
          rate_percent,
          profit_base,
          amount,
          status
        )

        VALUES (
          $1,
          NULL,
          $2,
          $3,
          $4,
          $5,
          'unallocated'
        )

        ON CONFLICT (order_id, level)
        DO NOTHING
        `,
        [
          orderId,
          level,
          rate,
          fromCents(profitCents),
          fromCents(amountCents)
        ]
      );

      unallocatedCommissionCents += amountCents;

      commissionDetails.push({
        level,
        memberId: null,
        rate,
        amount: fromCents(amountCents),
        status: "unallocated"
      });

    }
  }


  // 10. Record company profit.

  const totalCompanyShareCents =
    companyShareCents +
    unallocatedCommissionCents;

  await client.query(
    `
    INSERT INTO company_profit_ledger (
      order_id,
      gross_profit,
      company_share,
      unallocated_commission
    )

    VALUES (
      $1,
      $2,
      $3,
      $4
    )
    `,
    [
      orderId,
      fromCents(profitCents),
      fromCents(totalCompanyShareCents),
      fromCents(unallocatedCommissionCents)
    ]
  );


  // 11. Return commission summary.

  return {
    success: true,

    orderId: Number(orderId),

    orderNumber: order.order_number,

    revenue: profit.revenue,

    directCosts: profit.directCosts,

    gatewayFee: profit.gatewayFee,

    actualProfit: profit.actualProfit,

    companyShare: fromCents(
      totalCompanyShareCents
    ),

    allocatedCommission: fromCents(
      allocatedCommissionCents
    ),

    unallocatedCommission: fromCents(
      unallocatedCommissionCents
    ),

    levels: commissionDetails
  };

}


// =====================================================
// EXPORT
// =====================================================

module.exports = {
  DEFAULT_RATES,
  COMPANY_SHARE_PERCENT,
  TOTAL_COMMISSION_PERCENT,
  toCents,
  fromCents,
  validateRates,
  calculateOrderProfit,
  getSponsorChain,
  releaseOrderCommission
};
