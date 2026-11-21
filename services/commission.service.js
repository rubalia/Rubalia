
"use strict";

// =====================================================
// RUBALIA NETWORK
// 10 LEVEL UNILEVEL COMMISSION ENGINE
// =====================================================

const DEFAULT_RATES = [20, 15, 10, 8, 6, 5, 4, 3, 2, 2];

const COMPANY_SHARE_PERCENT = 25;
const TOTAL_COMMISSION_PERCENT = 75;
const LEVEL_COUNT = 10;

// =====================================================
// MONEY HELPERS
// =====================================================

function toCents(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    throw new Error("Invalid money value.");
  }

  return Math.round(number * 100);
}

function fromCents(value) {
  if (!Number.isSafeInteger(value)) {
    throw new Error("Invalid cents value.");
  }

  return (value / 100).toFixed(2);
}

function validateRates(rates) {
  if (typeof rates === "string") {
    try {
      rates = JSON.parse(rates);
    } catch {
      throw new Error("Invalid commission rate configuration.");
    }
  }

  if (!Array.isArray(rates) || rates.length !== LEVEL_COUNT) {
    throw new Error("Exactly 10 commission levels are required.");
  }

  const normalized = rates.map(Number);

  if (
    normalized.some(
      rate =>
        !Number.isFinite(rate) ||
        rate < 0 ||
        rate > TOTAL_COMMISSION_PERCENT
    )
  ) {
    throw new Error("Invalid commission percentage.");
  }

  const total = normalized.reduce((sum, rate) => sum + rate, 0);

  if (Math.abs(total - TOTAL_COMMISSION_PERCENT) > 0.0001) {
    throw new Error(
      "The total of all 10 commission levels must be exactly 75%."
    );
  }

  return normalized;
}

// =====================================================
// EXACT CENT-BASED COMMISSION ALLOCATION
//
// Uses largest remainder method.
// Sum of all 10 levels always equals commission pool.
// =====================================================

function calculateCommissionAllocation(profitCents, rates) {
  if (!Number.isSafeInteger(profitCents) || profitCents <= 0) {
    throw new Error("Invalid profit amount.");
  }

  const normalizedRates = validateRates(rates);

  const commissionPoolCents = Math.round(
    profitCents * TOTAL_COMMISSION_PERCENT / 100
  );

  const companyShareCents = profitCents - commissionPoolCents;

  const rawShares = normalizedRates.map((rate, index) => {
    const exact = profitCents * rate / 100;
    const base = Math.floor(exact);

    return {
      level: index + 1,
      rate,
      cents: base,
      remainder: exact - base
    };
  });

  let allocated = rawShares.reduce(
    (sum, item) => sum + item.cents,
    0
  );

  let remaining = commissionPoolCents - allocated;

  const priority = [...rawShares].sort((a, b) => {
    if (b.remainder !== a.remainder) {
      return b.remainder - a.remainder;
    }

    return a.level - b.level;
  });

  for (let i = 0; i < remaining; i++) {
    priority[i].cents += 1;
  }

  allocated = rawShares.reduce(
    (sum, item) => sum + item.cents,
    0
  );

  if (allocated !== commissionPoolCents) {
    throw new Error("Commission allocation validation failed.");
  }

  if (companyShareCents + allocated !== profitCents) {
    throw new Error("Company and commission split validation failed.");
  }

  return {
    companyShareCents,
    commissionPoolCents,
    levels: rawShares
      .sort((a, b) => a.level - b.level)
      .map(item => ({
        level: item.level,
        rate: item.rate,
        amountCents: item.cents
      }))
  };
}

// =====================================================
// COST SNAPSHOT VALIDATION
// =====================================================

function snapshotMoney(snapshot, key) {
  if (
    !snapshot ||
    snapshot[key] === undefined ||
    snapshot[key] === null
  ) {
    throw new Error(`Order cost snapshot is missing ${key}.`);
  }

  return toCents(snapshot[key]);
}

function calculateSnapshotItemCost(snapshot, itemType) {
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("Order cost snapshot is invalid.");
  }

  if (itemType === "product") {
    return (
      snapshotMoney(snapshot, "productCost") +
      snapshotMoney(snapshot, "deliveryCost") +
      snapshotMoney(snapshot, "packagingCost") +
      snapshotMoney(snapshot, "otherCost")
    );
  }

  if (itemType === "package") {
    if (
      !Array.isArray(snapshot.componentCosts) ||
      snapshot.componentCosts.length !== 3
    ) {
      throw new Error(
        "Package snapshot must contain exactly 3 component costs."
      );
    }

    let componentTotal = 0;

    for (const component of snapshot.componentCosts) {
      componentTotal +=
        snapshotMoney(component, "productCost") +
        snapshotMoney(component, "deliveryCost") +
        snapshotMoney(component, "packagingCost") +
        snapshotMoney(component, "otherCost");
    }

    const packageExtra =
      snapshotMoney(snapshot, "deliveryCost") +
      snapshotMoney(snapshot, "packagingCost") +
      snapshotMoney(snapshot, "otherCost");

    return componentTotal + packageExtra;
  }

  throw new Error("Unsupported order item type.");
}

// =====================================================
// CALCULATE ORDER NET PROFIT
// Uses only immutable order-time snapshots.
// =====================================================

async function calculateOrderProfit(
  client,
  orderId,
  gatewayFeePercent
) {
  const result = await client.query(
    `
    SELECT
      id,
      item_type,
      quantity,
      subtotal,
      cost_snapshot
    FROM order_items
    WHERE order_id = $1
    ORDER BY id
    FOR UPDATE
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

    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new Error("Invalid order quantity.");
    }

    const snapshot =
      typeof item.cost_snapshot === "string"
        ? JSON.parse(item.cost_snapshot)
        : item.cost_snapshot;

    if (!snapshot || Object.keys(snapshot).length === 0) {
      throw new Error(
        `Cost snapshot is missing for order item ${item.id}.`
      );
    }

    const subtotalCents = toCents(item.subtotal);

    const unitCostCents = calculateSnapshotItemCost(
      snapshot,
      item.item_type
    );

    revenueCents += subtotalCents;
    directCostCents += unitCostCents * quantity;
  }

  const feePercent = Number(gatewayFeePercent);

  if (
    !Number.isFinite(feePercent) ||
    feePercent < 0 ||
    feePercent > 100
  ) {
    throw new Error("Invalid payment gateway fee percentage.");
  }

  const gatewayFeeCents = Math.round(
    revenueCents * feePercent / 100
  );

  const actualProfitCents =
    revenueCents - directCostCents - gatewayFeeCents;

  if (actualProfitCents <= 0) {
    throw new Error(
      "The order has no positive net profit. Commission cannot be calculated."
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
  const visited = new Set([String(buyerId)]);

  let currentUserId = buyerId;

  for (let level = 1; level <= LEVEL_COUNT; level++) {
    if (!currentUserId) {
      sponsors.push(null);
      continue;
    }

    const result = await client.query(
      `
      SELECT sponsor_id
      FROM users
      WHERE id = $1
      `,
      [currentUserId]
    );

    const sponsorId = result.rows[0]?.sponsor_id || null;

    if (!sponsorId || visited.has(String(sponsorId))) {
      sponsors.push(null);
      currentUserId = null;
      continue;
    }

    sponsors.push(sponsorId);
    visited.add(String(sponsorId));
    currentUserId = sponsorId;
  }

  return sponsors;
}

// =====================================================
// CHECK SPONSOR COMMISSION ELIGIBILITY
// =====================================================

async function getEligibleSponsor(client, sponsorId) {
  if (!sponsorId) {
    return null;
  }

  const result = await client.query(
    `
    SELECT
      id,
      role,
      status,
      partner_activated_at
    FROM users
    WHERE id = $1
    FOR SHARE
    `,
    [sponsorId]
  );

  const sponsor = result.rows[0];

  if (!sponsor) return null;

  if (String(sponsor.status).toLowerCase() !== "active") {
    return null;
  }

  if (String(sponsor.role).toLowerCase() !== "partner") {
    return null;
  }

  if (!sponsor.partner_activated_at) {
    return null;
  }

  return sponsor;
}

// =====================================================
// CREATE WALLET IF NOT EXISTS
// =====================================================

async function getOrCreateWallet(client, memberId) {
  const result = await client.query(
    `
    INSERT INTO wallets (user_id)
    VALUES ($1)
    ON CONFLICT (user_id)
    DO UPDATE SET user_id = EXCLUDED.user_id
    RETURNING id
    `,
    [memberId]
  );

  return result.rows[0].id;
}

// =====================================================
// APPLY EXISTING COMMISSION REVERSAL DEBTS
// =====================================================

async function recoverCommissionDebts(
  client,
  memberId,
  availableCents
) {
  let remainingCents = availableCents;
  let recoveredCents = 0;

  const debtsResult = await client.query(
    `
    SELECT
      id,
      original_amount,
      recovered_amount
    FROM commission_reversal_debts
    WHERE user_id = $1
      AND status IN ('open', 'partially_recovered')
    ORDER BY created_at, id
    FOR UPDATE
    `,
    [memberId]
  );

  for (const debt of debtsResult.rows) {
    if (remainingCents <= 0) break;

    const outstandingCents =
      toCents(debt.original_amount) -
      toCents(debt.recovered_amount);

    if (outstandingCents <= 0) continue;

    const recovery = Math.min(
      remainingCents,
      outstandingCents
    );

    const newRecovered =
      toCents(debt.recovered_amount) + recovery;

    const fullyRecovered =
      newRecovered >= toCents(debt.original_amount);

    await client.query(
      `
      UPDATE commission_reversal_debts
      SET
        recovered_amount = $1,
        status = $2,
        updated_at = NOW()
      WHERE id = $3
      `,
      [
        fromCents(newRecovered),
        fullyRecovered ? "recovered" : "partially_recovered",
        debt.id
      ]
    );

    remainingCents -= recovery;
    recoveredCents += recovery;
  }

  return {
    creditedCents: remainingCents,
    recoveredCents
  };
}

// =====================================================
// CREDIT MEMBER WALLET
// Must be called inside a PostgreSQL transaction.
// =====================================================

async function creditMemberWallet(
  client,
  memberId,
  amountCents,
  orderId,
  level,
  ledgerId
) {
  if (amountCents <= 0) {
    return {
      creditedCents: 0,
      recoveredCents: 0
    };
  }

  const walletId = await getOrCreateWallet(
    client,
    memberId
  );

  const recovery = await recoverCommissionDebts(
    client,
    memberId,
    amountCents
  );

  if (recovery.creditedCents > 0) {
    await client.query(
      `
      UPDATE wallets
      SET
        balance = balance + $1,
        updated_at = NOW()
      WHERE id = $2
      `,
      [fromCents(recovery.creditedCents), walletId]
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
      VALUES ($1, 'commission', $2, $3, $4, 'completed')
      `,
      [
        walletId,
        fromCents(recovery.creditedCents),
        `COM-${orderId}-L${level}`,
        `Level ${level} commission from order ${orderId}`
      ]
    );
  }

  if (recovery.recoveredCents > 0) {
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
      VALUES ($1, 'commission_reversal', $2, $3, $4, 'completed')
      `,
      [
        walletId,
        fromCents(recovery.recoveredCents),
        `COM-DEBT-RECOVERY-${ledgerId}`,
        "Recovery of previous commission reversal debt"
      ]
    );
  }

  return recovery;
}

// =====================================================
// PREPARE COMMISSION AFTER ORDER DELIVERY
// =====================================================

async function prepareOrderCommission(client, orderId) {
  const settingsResult = await client.query(
    `
    SELECT
      enabled,
      legal_approval_confirmed,
      gateway_fee_percent,
      level_rates,
      refund_period_days
    FROM commission_settings
    WHERE id = 1
    FOR SHARE
    `
  );

  const settings = settingsResult.rows[0];

  if (!settings || !settings.enabled) {
    return {
      success: false,
      status: "not_eligible",
      message: "Commission system is disabled."
    };
  }

  if (!settings.legal_approval_confirmed) {
    return {
      success: false,
      status: "not_eligible",
      message: "Required legal approval has not been confirmed."
    };
  }

  const rates = validateRates(settings.level_rates);

  const orderResult = await client.query(
    `
    SELECT
      id,
      user_id,
      order_number,
      status,
      payment_status,
      payment_method,
      delivered_at,
      refund_period_ends_at,
      commission_status
    FROM orders
    WHERE id = $1
    FOR UPDATE
    `,
    [orderId]
  );

  const order = orderResult.rows[0];

  if (!order) {
    throw new Error("Order not found.");
  }

  if (
    order.status !== "delivered" ||
    order.payment_status !== "paid"
  ) {
    throw new Error(
      "Only paid and delivered orders can enter the commission workflow."
    );
  }

  if (
    order.commission_status === "pending" ||
    order.commission_status === "released"
  ) {
    return {
      success: true,
      duplicate: true,
      status: order.commission_status,
      message: "Commission workflow already exists."
    };
  }

  if (order.commission_status === "reversed") {
    throw new Error(
      "A reversed order cannot be prepared for commission again."
    );
  }

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

  // Exact integer-cent split: company + commission = 100%.
  const allocation = calculateCommissionAllocation(
    profitCents,
    rates
  );

  const deliveredAt = order.delivered_at
    ? new Date(order.delivered_at)
    : new Date();

  const refundPeriodDays = Number(settings.refund_period_days);

  if (
    !Number.isInteger(refundPeriodDays) ||
    refundPeriodDays < 0 ||
    refundPeriodDays > 365
  ) {
    throw new Error("Invalid refund period configuration.");
  }

  const refundPeriodEndsAt = new Date(
    deliveredAt.getTime() +
    refundPeriodDays * 24 * 60 * 60 * 1000
  );

  const sponsorChain = await getSponsorChain(
    client,
    order.user_id
  );

  for (const levelEntry of allocation.levels) {
    const sponsorId = sponsorChain[levelEntry.level - 1];

    const eligibleSponsor = await getEligibleSponsor(
      client,
      sponsorId
    );

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
      VALUES ($1, $2, $3, $4, $5, $6, 'pending')
      ON CONFLICT (order_id, level)
      DO NOTHING
      `,
      [
        orderId,
        eligibleSponsor ? eligibleSponsor.id : null,
        levelEntry.level,
        levelEntry.rate,
        fromCents(profitCents),
        fromCents(levelEntry.amountCents)
      ]
    );
  }

  await client.query(
    `
    INSERT INTO company_profit_ledger (
      order_id,
      gross_profit,
      company_share,
      unallocated_commission
    )
    VALUES ($1, $2, $3, 0)
    ON CONFLICT (order_id)
    DO NOTHING
    `,
    [
      orderId,
      fromCents(profitCents),
      fromCents(allocation.companyShareCents)
    ]
  );

  await client.query(
    `
    UPDATE orders
    SET
      delivered_at = COALESCE(delivered_at, $1),
      refund_period_ends_at = $2,
      commission_status = 'pending',
      updated_at = NOW()
    WHERE id = $3
    `,
    [deliveredAt, refundPeriodEndsAt, orderId]
  );

  return {
    success: true,
    status: "pending",
    orderId: Number(orderId),
    orderNumber: order.order_number,
    revenue: profit.revenue,
    directCosts: profit.directCosts,
    gatewayFee: profit.gatewayFee,
    netProfit: profit.actualProfit,
    companyShare: fromCents(allocation.companyShareCents),
    commissionPool: fromCents(allocation.commissionPoolCents),
    refundPeriodEndsAt
  };
}

// =====================================================
// RELEASE MATURED COMMISSION
// =====================================================

async function releaseOrderCommission(client, orderId) {
  const settingsResult = await client.query(
    `
    SELECT
      enabled,
      legal_approval_confirmed
    FROM commission_settings
    WHERE id = 1
    FOR SHARE
    `
  );

  const settings = settingsResult.rows[0];

  if (!settings || !settings.enabled) {
    throw new Error("Commission engine is disabled.");
  }

  if (!settings.legal_approval_confirmed) {
    throw new Error(
      "Required legal approval has not been confirmed."
    );
  }

  const orderResult = await client.query(
    `
    SELECT
      id,
      order_number,
      status,
      payment_status,
      commission_status,
      refund_period_ends_at
    FROM orders
    WHERE id = $1
    FOR UPDATE
    `,
    [orderId]
  );

  const order = orderResult.rows[0];

  if (!order) {
    throw new Error("Order not found.");
  }

  if (
    order.status !== "delivered" ||
    order.payment_status !== "paid"
  ) {
    throw new Error(
      "Only paid and delivered orders can release commission."
    );
  }

  if (order.commission_status === "released") {
    return {
      success: true,
      duplicate: true,
      message: "Commission has already been released."
    };
  }

  if (order.commission_status !== "pending") {
    throw new Error("Order does not have pending commission.");
  }

  if (!order.refund_period_ends_at) {
    throw new Error("Refund period end time is missing.");
  }

  const maturity = new Date(order.refund_period_ends_at);

  if (Number.isNaN(maturity.getTime()) || maturity > new Date()) {
    throw new Error(
      "Refund/return period has not ended. Commission cannot be released yet."
    );
  }

  const ledgerResult = await client.query(
    `
    SELECT
      id,
      beneficiary_id,
      level,
      rate_percent,
      profit_base,
      amount,
      status
    FROM commission_ledger
    WHERE order_id = $1
    ORDER BY level
    FOR UPDATE
    `,
    [orderId]
  );

  if (ledgerResult.rows.length !== LEVEL_COUNT) {
    throw new Error(
      "Commission ledger is incomplete. Expected exactly 10 levels."
    );
  }

  let allocatedCents = 0;
  let unallocatedCents = 0;
  const levels = [];

  for (const entry of ledgerResult.rows) {
    if (entry.status !== "pending") {
      throw new Error(
        "Commission ledger contains a non-pending entry."
      );
    }

    const amountCents = toCents(entry.amount);

    const eligibleSponsor = await getEligibleSponsor(
      client,
      entry.beneficiary_id
    );

    if (!eligibleSponsor) {
      await client.query(
        `
        UPDATE commission_ledger
        SET
          beneficiary_id = NULL,
          status = 'unallocated'
        WHERE id = $1
        `,
        [entry.id]
      );

      unallocatedCents += amountCents;

      levels.push({
        level: Number(entry.level),
        amount: fromCents(amountCents),
        status: "unallocated"
      });

      continue;
    }

    const walletResult = await creditMemberWallet(
      client,
      eligibleSponsor.id,
      amountCents,
      orderId,
      Number(entry.level),
      entry.id
    );

    await client.query(
      `
      UPDATE commission_ledger
      SET
        status = 'credited',
        released_at = NOW()
      WHERE id = $1
      `,
      [entry.id]
    );

    allocatedCents += amountCents;

    levels.push({
      level: Number(entry.level),
      memberId: Number(eligibleSponsor.id),
      amount: fromCents(amountCents),
      credited: fromCents(walletResult.creditedCents),
      debtRecovered: fromCents(walletResult.recoveredCents),
      status: "credited"
    });
  }

  const companyResult = await client.query(
    `
    SELECT
      gross_profit,
      company_share
    FROM company_profit_ledger
    WHERE order_id = $1
    FOR UPDATE
    `,
    [orderId]
  );

  if (!companyResult.rows.length) {
    throw new Error("Company profit ledger not found.");
  }

  const companyShareCents = toCents(
    companyResult.rows[0].company_share
  );

  await client.query(
    `
    UPDATE company_profit_ledger
    SET unallocated_commission = $1
    WHERE order_id = $2
    `,
    [fromCents(unallocatedCents), orderId]
  );

  await client.query(
    `
    UPDATE orders
    SET
      commission_status = 'released',
      updated_at = NOW()
    WHERE id = $1
    `,
    [orderId]
  );

  return {
    success: true,
    orderId: Number(orderId),
    orderNumber: order.order_number,
    companyShare: fromCents(companyShareCents),
    allocatedCommission: fromCents(allocatedCents),
    unallocatedCommission: fromCents(unallocatedCents),
    totalCompanyRetained: fromCents(
      companyShareCents + unallocatedCents
    ),
    levels
  };
}

// =====================================================
// REVERSE COMMISSION ON REFUND
// Pending entries are voided.
// Released entries are debited from available wallet
// balances. Any amount already spent becomes debt.
// =====================================================

async function reverseOrderCommission(client, orderId) {
  const orderResult = await client.query(
    `
    SELECT
      id,
      status,
      payment_status,
      commission_status
    FROM orders
    WHERE id = $1
    FOR UPDATE
    `,
    [orderId]
  );

  const order = orderResult.rows[0];

  if (!order) {
    throw new Error("Order not found.");
  }

  if (order.commission_status === "reversed") {
    return {
      success: true,
      duplicate: true,
      message: "Commission has already been reversed."
    };
  }

  if (order.commission_status === "not_eligible") {
    return {
      success: true,
      message: "This order has no commission to reverse."
    };
  }

  const ledgerResult = await client.query(
    `
    SELECT
      id,
      beneficiary_id,
      level,
      amount,
      status
    FROM commission_ledger
    WHERE order_id = $1
    ORDER BY level
    FOR UPDATE
    `,
    [orderId]
  );

  let reversedCents = 0;
  let debtCreatedCents = 0;

  for (const entry of ledgerResult.rows) {
    if (
      entry.status === "reversed" ||
      entry.status === "unallocated"
    ) {
      continue;
    }

    const amountCents = toCents(entry.amount);

    if (entry.status === "pending") {
      await client.query(
        `
        UPDATE commission_ledger
        SET
          status = 'reversed',
          reversed_at = NOW()
        WHERE id = $1
        `,
        [entry.id]
      );

      continue;
    }

    if (
      entry.status !== "credited" ||
      !entry.beneficiary_id ||
      amountCents <= 0
    ) {
      continue;
    }

    const walletId = await getOrCreateWallet(
      client,
      entry.beneficiary_id
    );

    const walletResult = await client.query(
      `
      SELECT id, balance
      FROM wallets
      WHERE id = $1
      FOR UPDATE
      `,
      [walletId]
    );

    const availableCents = toCents(
      walletResult.rows[0].balance
    );

    const debitCents = Math.min(
      availableCents,
      amountCents
    );

    const debtCents = amountCents - debitCents;

    if (debitCents > 0) {
      await client.query(
        `
        UPDATE wallets
        SET
          balance = balance - $1,
          updated_at = NOW()
        WHERE id = $2
        `,
        [fromCents(debitCents), walletId]
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
          'commission_reversal',
          $2,
          $3,
          $4,
          'completed'
        )
        `,
        [
          walletId,
          fromCents(debitCents),
          `COM-REV-${orderId}-L${entry.level}`,
          `Reversal of level ${entry.level} commission for order ${orderId}`
        ]
      );
    }

    if (debtCents > 0) {
      await client.query(
        `
        INSERT INTO commission_reversal_debts (
          user_id,
          order_id,
          commission_ledger_id,
          original_amount,
          recovered_amount,
          status
        )
        VALUES ($1, $2, $3, $4, 0, 'open')
        ON CONFLICT (commission_ledger_id)
        DO NOTHING
        `,
        [
          entry.beneficiary_id,
          orderId,
          entry.id,
          fromCents(debtCents)
        ]
      );

      debtCreatedCents += debtCents;
    }

    await client.query(
      `
      UPDATE commission_ledger
      SET
        status = 'reversed',
        reversed_at = NOW()
      WHERE id = $1
      `,
      [entry.id]
    );

    reversedCents += amountCents;
  }

  await client.query(
    `
    UPDATE orders
    SET
      commission_status = 'reversed',
      updated_at = NOW()
    WHERE id = $1
    `,
    [orderId]
  );

  return {
    success: true,
    orderId: Number(orderId),
    reversedCommission: fromCents(reversedCents),
    outstandingDebtCreated: fromCents(debtCreatedCents)
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
  calculateCommissionAllocation,

  calculateSnapshotItemCost,
  calculateOrderProfit,

  getSponsorChain,
  getEligibleSponsor,

  prepareOrderCommission,
  releaseOrderCommission,
  reverseOrderCommission
};
