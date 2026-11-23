"use strict";

// =====================================================
// RUBALIA NETWORK
// AUTOMATIC MONTHLY FINANCIAL REPORT WORKER
// =====================================================

const {
  createMonthlyReport,
  previousMonthStart
} = require("../services/monthly-financial-report.service");


// =====================================================
// WORKER SETTINGS
// =====================================================

const CHECK_INTERVAL = 10 * 60 * 1000; // 10 minutes

let timer = null;

let running = false;


// =====================================================
// CHECK AND GENERATE MONTHLY REPORT
// =====================================================

async function checkAndGenerateMonthlyReport(db) {

  // Prevent overlapping execution

  if (running) {
    return;
  }

  running = true;

  try {

    // Previous completed calendar month
    // Based on Bangladesh timezone

    const monthStart = previousMonthStart(new Date());

    const month = monthStart.slice(0, 7);


    console.log(
      "[Monthly Report] Checking report for:",
      month
    );


    // Generate report

    const result = await createMonthlyReport(
      db,
      month,
      null
    );


    if (result.created) {

      console.log(
        "[Monthly Report] PDF successfully generated:",
        month
      );

    } else {

      console.log(
        "[Monthly Report] Report already exists:",
        month
      );

    }

  } catch (error) {

    console.error(
      "[Monthly Report] Generation failed:",
      error.message
    );

  } finally {

    running = false;

  }

}


// =====================================================
// START MONTHLY REPORT WORKER
// =====================================================

function startMonthlyFinancialReportWorker(db) {

  // Avoid duplicate workers

  if (timer) {

    console.log(
      "[Monthly Report] Worker is already running."
    );

    return;

  }


  console.log(
    "[Monthly Report] Worker started."
  );


  console.log(
    "[Monthly Report] Timezone: Asia/Dhaka"
  );


  // Run immediately after server startup.
  // This also catches up a missed previous-month report.

  checkAndGenerateMonthlyReport(db);


  // Check periodically for missed reports

  timer = setInterval(() => {

    checkAndGenerateMonthlyReport(db);

  }, CHECK_INTERVAL);


  // Allow Node.js to exit naturally when no other
  // work is keeping the process alive.

  if (typeof timer.unref === "function") {

    timer.unref();

  }

}


// =====================================================
// STOP MONTHLY REPORT WORKER
// =====================================================

function stopMonthlyFinancialReportWorker() {

  if (timer) {

    clearInterval(timer);

    timer = null;

    console.log(
      "[Monthly Report] Worker stopped."
    );

  }

}


// =====================================================
// EXPORTS
// =====================================================

module.exports = {

  startMonthlyFinancialReportWorker,

  stopMonthlyFinancialReportWorker,

  checkAndGenerateMonthlyReport

};
