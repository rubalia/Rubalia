
"use strict";

// =====================================================
// RUBALIA NETWORK
// AUTOMATIC COMMISSION RELEASE WORKER
//
// Checks every 30 seconds for delivered orders whose
// refund period has ended.
//
// Safe for multiple server instances using
// PostgreSQL FOR UPDATE SKIP LOCKED.
// =====================================================

const {
  releaseOrderCommission
} = require("../services/commission.service");

const CHECK_INTERVAL_MS = 30 * 1000;
const MAX_ORDERS_PER_CYCLE = 25;

let workerTimer = null;
let workerRunning = false;
let workerStopping = false;

// =====================================================
// PROCESS ONE MATURED ORDER
// =====================================================

async function processOneMaturedOrder(pool) {
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;

    // Lock one matured order.
    // Other worker instances will skip this locked row.
    const result = await client.query(
      `
      SELECT
        id,
        order_number
      FROM orders
      WHERE status = 'delivered'
        AND payment_status = 'paid'
        AND commission_status = 'pending'
        AND refund_period_ends_at IS NOT NULL
        AND refund_period_ends_at <= NOW()
      ORDER BY refund_period_ends_at ASC, id ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
      `
    );

    if (!result.rows.length) {
      await client.query("COMMIT");
      transactionStarted = false;

      return {
        processed: false,
        reason: "no_matured_order"
      };
    }

    const order = result.rows[0];

    // Release commission inside the same transaction.
    // This function re-checks payment, status and maturity.
    const releaseResult = await releaseOrderCommission(
      client,
      order.id
    );

    await client.query("COMMIT");
    transactionStarted = false;

    console.log(
      `[Commission Worker] Released order ${order.order_number || order.id}`
    );

    return {
      processed: true,
      orderId: Number(order.id),
      orderNumber: order.order_number,
      result: releaseResult
    };

  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => {});
      transactionStarted = false;
    }

    console.error(
      "[Commission Worker] Order processing failed:",
      error.message
    );

    return {
      processed: false,
      error: error.message
    };

  } finally {
    client.release();
  }
}

// =====================================================
// RUN ONE WORKER CYCLE
// =====================================================

async function runCommissionWorkerCycle(pool) {
  if (workerRunning || workerStopping) {
    return {
      skipped: true,
      reason: "worker_already_running_or_stopping"
    };
  }

  workerRunning = true;

  let processedCount = 0;
  let failedCount = 0;

  try {
    for (
      let index = 0;
      index < MAX_ORDERS_PER_CYCLE;
      index++
    ) {
      if (workerStopping) {
        break;
      }

      const result = await processOneMaturedOrder(pool);

      if (!result.processed) {
        if (result.error) {
          failedCount++;
        }

        if (result.reason === "no_matured_order") {
          break;
        }

        // Avoid repeatedly retrying the same failing order
        // during this cycle.
        if (result.error) {
          break;
        }
      } else {
        processedCount++;
      }
    }

    if (processedCount > 0 || failedCount > 0) {
      console.log(
        `[Commission Worker] Cycle finished. ` +
        `Released: ${processedCount}, Failed: ${failedCount}`
      );
    }

    return {
      success: failedCount === 0,
      processedCount,
      failedCount
    };

  } catch (error) {
    console.error(
      "[Commission Worker] Cycle failed:",
      error.message
    );

    return {
      success: false,
      processedCount,
      failedCount: failedCount + 1,
      error: error.message
    };

  } finally {
    workerRunning = false;
  }
}

// =====================================================
// START WORKER
// Call only after database migrations complete.
// =====================================================

function startCommissionWorker(pool) {
  if (!pool || typeof pool.connect !== "function") {
    throw new Error(
      "A valid PostgreSQL pool is required for Commission Worker."
    );
  }

  if (workerTimer) {
    console.log(
      "[Commission Worker] Worker is already started."
    );

    return workerTimer;
  }

  workerStopping = false;

  console.log(
    "[Commission Worker] Started. Checking every 30 seconds."
  );

  // Run once immediately after startup.
  runCommissionWorkerCycle(pool).catch(error => {
    console.error(
      "[Commission Worker] Initial cycle failed:",
      error.message
    );
  });

  workerTimer = setInterval(() => {
    runCommissionWorkerCycle(pool).catch(error => {
      console.error(
        "[Commission Worker] Scheduled cycle failed:",
        error.message
      );
    });
  }, CHECK_INTERVAL_MS);

  if (typeof workerTimer.unref === "function") {
    workerTimer.unref();
  }

  return workerTimer;
}

// =====================================================
// STOP WORKER
// =====================================================

async function stopCommissionWorker() {
  workerStopping = true;

  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }

  // Allow an active cycle to finish.
  while (workerRunning) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  console.log("[Commission Worker] Stopped.");
}

// =====================================================
// EXPORT
// =====================================================

module.exports = {
  startCommissionWorker,
  stopCommissionWorker,
  runCommissionWorkerCycle,
  processOneMaturedOrder
};
