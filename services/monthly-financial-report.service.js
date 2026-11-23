"use strict";

const PDFDocument = require("pdfkit");

// =====================================================
// RUBALIA NETWORK
// MONTHLY FINANCIAL REPORT SERVICE
// =====================================================


// =====================================================
// DATE HELPERS (BANGLADESH TIME)
// =====================================================

function datePartsInDhaka(date = new Date()) {

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dhaka",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts.map(part => [part.type, part.value])
  );

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day)
  };
}


// Previous calendar month

function previousMonthStart(date = new Date()) {

  const { year, month } = datePartsInDhaka(date);

  const previous = new Date(
    Date.UTC(year, month - 2, 1)
  );

  return previous.toISOString().slice(0, 10);
}


// Validate YYYY-MM

function validMonth(value) {

  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}$/.test(value) &&
    Number(value.slice(5, 7)) >= 1 &&
    Number(value.slice(5, 7)) <= 12
  );
}


// Get month date range

function monthRange(month) {

  if (!validMonth(month)) {
    throw new Error("Month must use YYYY-MM format.");
  }

  const start = month + "-01";

  const [year, mon] = month.split("-").map(Number);

  const end = new Date(
    Date.UTC(year, mon, 0)
  ).toISOString().slice(0, 10);

  return {
    start,
    end
  };
}


// =====================================================
// MONEY HELPERS
// =====================================================

function moneyCents(value) {

  const number = Number(value);

  if (!Number.isFinite(number) || number < 0) {
    throw new Error("Invalid historical cost value.");
  }

  return Math.round(number * 100);
}


function formatMoney(value) {

  if (value === null || value === undefined) {
    return "NOT AVAILABLE";
  }

  return "BDT " + Number(value).toLocaleString("en-BD", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}


// =====================================================
// PRODUCT AND PACKAGE COST SNAPSHOT
// =====================================================

function snapshotCostCents(snapshot, itemType) {

  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    !Object.keys(snapshot).length
  ) {
    return null;
  }


  // PRODUCT COST

  if (itemType === "product") {

    const keys = [
      "productCost",
      "deliveryCost",
      "packagingCost",
      "otherCost"
    ];

    for (const key of keys) {

      if (
        snapshot[key] === undefined ||
        snapshot[key] === null
      ) {
        return null;
      }
    }

    return keys.reduce(
      (sum, key) => sum + moneyCents(snapshot[key]),
      0
    );
  }


  // PACKAGE COST

  if (itemType === "package") {

    if (
      !Array.isArray(snapshot.componentCosts) ||
      snapshot.componentCosts.length !== 3
    ) {
      return null;
    }

    let total = 0;

    for (const component of snapshot.componentCosts) {

      if (
        component.productCost === undefined ||
        component.productCost === null
      ) {
        return null;
      }

      total += moneyCents(component.productCost);
    }

    const extraKeys = [
      "deliveryCost",
      "packagingCost",
      "otherCost"
    ];

    for (const key of extraKeys) {

      if (
        snapshot[key] === undefined ||
        snapshot[key] === null
      ) {
        return null;
      }

      total += moneyCents(snapshot[key]);
    }

    return total;
  }

  return null;
}


// =====================================================
// PDF GENERATOR
// =====================================================

function buildPdf(data) {

  return new Promise((resolve, reject) => {

    const doc = new PDFDocument({

      size: "A4",
      margin: 48,

      info: {
        Title: "RUBALIA NETWORK Monthly Financial Report",
        Author: "RUBALIA NETWORK"
      }

    });

    const chunks = [];

    doc.on("data", chunk => {
      chunks.push(chunk);
    });

    doc.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    doc.on("error", reject);


    // HEADER

    doc.rect(
      0,
      0,
      doc.page.width,
      95
    ).fill("#071a35");

    doc.fillColor("#ffffff")
      .font("Helvetica-Bold")
      .fontSize(20)
      .text(
        "RUBALIA NETWORK",
        48,
        30
      );

    doc.fillColor("#e4d3a8")
      .font("Helvetica")
      .fontSize(10)
      .text(
        "MONTHLY BUSINESS & FINANCIAL REPORT",
        48,
        60
      );


    // REPORT PERIOD

    doc.fillColor("#071a35")
      .font("Helvetica-Bold")
      .fontSize(15)
      .text(
        data.month_label,
        48,
        118
      );

    doc.fillColor("#667085")
      .font("Helvetica")
      .fontSize(9)
      .text(
        "Reporting Period: " +
        data.period_start +
        " to " +
        data.period_end,
        48,
        142
      );

    doc.text(
      "Generated: " + data.generated_at,
      48,
      156
    );


    // FINANCIAL SUMMARY

    let y = 192;

    doc.fillColor("#071a35")
      .font("Helvetica-Bold")
      .fontSize(13)
      .text(
        "FINANCIAL SUMMARY",
        48,
        y
      );

    y += 28;


    const rows = [

      [
        "Total Packages Sold",
        String(data.totals.packages_sold)
      ],

      [
        "Total Package Sales",
        formatMoney(data.totals.package_sales)
      ],

      [
        "Total Sales Revenue",
        formatMoney(data.totals.total_sales)
      ],

      [
        "Commission Paid",
        formatMoney(data.totals.commission_paid)
      ],

      [
        "Product Purchase Cost",
        formatMoney(data.totals.product_purchase_cost)
      ],

      [
        "Other Company Expenses",
        formatMoney(data.totals.other_expenses)
      ],

      [
        "Total Expenses",
        formatMoney(data.totals.total_expenses)
      ],

      [
        "NET PROFIT",
        formatMoney(data.totals.net_profit)
      ]

    ];


    for (const row of rows) {

      const isProfit = row[0] === "NET PROFIT";

      if (isProfit) {

        doc.rect(
          44,
          y - 5,
          doc.page.width - 88,
          30
        ).fill("#edf4ef");

      }

      doc.fillColor(
        isProfit ? "#126443" : "#26364b"
      );

      doc.font(
        isProfit ? "Helvetica-Bold" : "Helvetica"
      );

      doc.fontSize(isProfit ? 11 : 10);

      doc.text(
        row[0],
        54,
        y + 3,
        { width: 290 }
      );

      doc.text(
        row[1],
        345,
        y + 3,
        {
          width: 145,
          align: "right"
        }
      );

      y += 34;
    }


    // PACKAGE BREAKDOWN

    y += 20;

    if (y > 680) {
      doc.addPage();
      y = 55;
    }

    doc.fillColor("#071a35")
      .font("Helvetica-Bold")
      .fontSize(12)
      .text(
        "PACKAGE SALES BREAKDOWN",
        48,
        y
      );

    y += 28;

    doc.font("Helvetica-Bold")
      .fontSize(9)
      .fillColor("#667085");

    doc.text("Package", 50, y);

    doc.text(
      "Quantity",
      305,
      y,
      { width: 75, align: "right" }
    );

    doc.text(
      "Sales (BDT)",
      390,
      y,
      { width: 100, align: "right" }
    );

    y += 17;

    doc.moveTo(48, y)
      .lineTo(500, y)
      .strokeColor("#dfe5ed")
      .stroke();

    y += 10;

    doc.font("Helvetica")
      .fontSize(9)
      .fillColor("#26364b");


    if (!data.package_sales.length) {

      doc.text(
        "No package sales recorded for this month.",
        50,
        y
      );

      y += 20;

    } else {

      for (const item of data.package_sales) {

        if (y > 710) {
          doc.addPage();
          y = 55;
        }

        doc.text(
          String(item.package_name).slice(0, 42),
          50,
          y,
          { width: 240 }
        );

        doc.text(
          String(item.quantity),
          305,
          y,
          { width: 75, align: "right" }
        );

        doc.text(
          formatMoney(item.sales_amount),
          390,
          y,
          { width: 100, align: "right" }
        );

        y += 21;
      }
    }


    // DATA WARNINGS

    if (data.warnings.length) {

      y += 20;

      if (y > 700) {
        doc.addPage();
        y = 55;
      }

      doc.fillColor("#9a5b12")
        .font("Helvetica-Bold")
        .fontSize(10)
        .text(
          "DATA NOTES",
          48,
          y
        );

      y += 18;

      doc.font("Helvetica")
        .fontSize(8);

      for (const warning of data.warnings) {

        doc.text(
          "- " + warning,
          50,
          y,
          { width: 450 }
        );

        y += 28;
      }
    }


    // FOOTER

    const footerY = doc.page.height - 55;

    doc.fillColor("#8993a2")
      .font("Helvetica")
      .fontSize(8)
      .text(
        "Generated automatically by RUBALIA NETWORK.",
        48,
        footerY,
        {
          width: 500,
          align: "center"
        }
      );

    doc.text(
      "Official Monthly Financial Statement",
      48,
      footerY + 13,
      {
        width: 500,
        align: "center"
      }
    );

    doc.end();

  });
}


// =====================================================
// CREATE MONTHLY REPORT
// =====================================================

async function createMonthlyReport(
  db,
  month,
  generatedBy = null
) {

  const {
    start,
    end
  } = monthRange(month);


  // PREVENT DUPLICATE REPORT

  const existing = await db.query(
    `
    SELECT
      id,
      report_data

    FROM monthly_financial_reports

    WHERE month_start = $1
    `,
    [start]
  );

  if (existing.rowCount) {

    return {
      created: false,
      report: existing.rows[0]
    };

  }


  // ================================================
  // TOTAL SALES
  // ================================================

  const salesResult = await db.query(
    `
    SELECT

      COALESCE(
        SUM(oi.subtotal),
        0
      ) AS total_sales,

      COUNT(DISTINCT o.id)::BIGINT
        AS order_count

    FROM orders o

    JOIN order_items oi
      ON oi.order_id = o.id

    WHERE
      (o.created_at AT TIME ZONE 'Asia/Dhaka') >= $1::date

      AND
      (o.created_at AT TIME ZONE 'Asia/Dhaka') < ($2::date + INTERVAL '1 day')

      AND o.payment_status = 'paid'

      AND o.status <> 'cancelled'
    `,
    [start, end]
  );


  // ================================================
  // PACKAGE SALES BREAKDOWN
  // ================================================

  const packageResult = await db.query(
    `
    SELECT

      oi.product_name AS package_name,

      COALESCE(
        SUM(oi.quantity),
        0
      )::BIGINT AS quantity,

      COALESCE(
        SUM(oi.subtotal),
        0
      ) AS sales_amount

    FROM order_items oi

    JOIN orders o
      ON o.id = oi.order_id

    WHERE
      oi.item_type = 'package'

      AND
      (o.created_at AT TIME ZONE 'Asia/Dhaka') >= $1::date

      AND
      (o.created_at AT TIME ZONE 'Asia/Dhaka') < ($2::date + INTERVAL '1 day')

      AND o.payment_status = 'paid'

      AND o.status <> 'cancelled'

    GROUP BY oi.product_name

    ORDER BY oi.product_name
    `,
    [start, end]
  );


  // ================================================
  // PRODUCT PURCHASE COST
  // ================================================

  const itemResult = await db.query(
    `
    SELECT

      oi.item_type,

      oi.quantity,

      oi.cost_snapshot

    FROM order_items oi

    JOIN orders o
      ON o.id = oi.order_id

    WHERE
      (o.created_at AT TIME ZONE 'Asia/Dhaka') >= $1::date

      AND
      (o.created_at AT TIME ZONE 'Asia/Dhaka') < ($2::date + INTERVAL '1 day')

      AND o.payment_status = 'paid'

      AND o.status <> 'cancelled'
    `,
    [start, end]
  );


  let purchaseCostCents = 0;

  let missingCostSnapshots = 0;


  for (const item of itemResult.rows) {

    const snapshot =
      typeof item.cost_snapshot === "string"
        ? JSON.parse(item.cost_snapshot)
        : item.cost_snapshot;


    const unitCost = snapshotCostCents(
      snapshot,
      item.item_type
    );


    if (unitCost === null) {

      missingCostSnapshots++;

      continue;

    }


    purchaseCostCents +=
      unitCost * Number(item.quantity);

  }


  // ================================================
  // COMMISSION PAID
  // ================================================

  const commissionResult = await db.query(
    `
    SELECT

      COALESCE(
        SUM(amount),
        0
      ) AS commission_paid

    FROM commission_ledger

    WHERE

      (created_at AT TIME ZONE 'Asia/Dhaka') >= $1::date

      AND
      (created_at AT TIME ZONE 'Asia/Dhaka') < ($2::date + INTERVAL '1 day')

      AND status = 'credited'
    `,
    [start, end]
  );


  // ================================================
  // OTHER COMPANY EXPENSES
  // ================================================

  const expenseResult = await db.query(
    `
    SELECT

      COALESCE(
        SUM(amount),
        0
      ) AS other_expenses

    FROM company_expenses

    WHERE
      expense_date >= $1::date

      AND expense_date <= $2::date
    `,
    [start, end]
  );


  // ================================================
  // FINAL CALCULATION
  // ================================================

  const totalSales = Number(
    salesResult.rows[0].total_sales || 0
  );

  const commissionPaid = Number(
    commissionResult.rows[0].commission_paid || 0
  );

  const purchaseCost =
    purchaseCostCents / 100;

  const otherExpenses = Number(
    expenseResult.rows[0].other_expenses || 0
  );


  const totalExpenses =
    commissionPaid +
    purchaseCost +
    otherExpenses;


  const warnings = [];


  if (missingCostSnapshots > 0) {

    warnings.push(
      missingCostSnapshots +
      " order item(s) have missing or incomplete historical cost snapshots. " +
      "Net profit cannot be considered final until these costs are verified."
    );

  }


  // Never publish an inaccurate profit figure.

  const netProfit = missingCostSnapshots > 0
    ? null
    : totalSales - totalExpenses;


  // ================================================
  // REPORT DATA
  // ================================================

  const monthLabel = new Intl.DateTimeFormat(
    "en",
    {
      month: "long",
      year: "numeric",
      timeZone: "UTC"
    }
  ).format(
    new Date(start + "T00:00:00Z")
  );


  const data = {

    month,

    month_label: monthLabel,

    period_start: start,

    period_end: end,

    generated_at: new Date().toISOString(),

    totals: {

      packages_sold:
        packageResult.rows.reduce(
          (sum, item) =>
            sum + Number(item.quantity),
          0
        ),

      package_sales:
        packageResult.rows.reduce(
          (sum, item) =>
            sum + Number(item.sales_amount),
          0
        ),

      total_sales: totalSales,

      commission_paid: commissionPaid,

      product_purchase_cost: purchaseCost,

      other_expenses: otherExpenses,

      total_expenses: totalExpenses,

      net_profit: netProfit,

      order_count: Number(
        salesResult.rows[0].order_count || 0
      ),

      missing_cost_items: missingCostSnapshots

    },

    package_sales:
      packageResult.rows.map(item => ({

        package_name: item.package_name,

        quantity: Number(item.quantity),

        sales_amount: Number(item.sales_amount)

      })),

    warnings

  };


  // ================================================
  // GENERATE PDF
  // ================================================

  const pdfBuffer = await buildPdf(data);


  // ================================================
  // SAVE PERMANENT SNAPSHOT
  // ================================================

  const inserted = await db.query(
    `
    INSERT INTO monthly_financial_reports (

      month_start,

      month_end,

      report_data,

      pdf_data,

      generated_by

    )

    VALUES (

      $1,

      $2,

      $3::jsonb,

      $4,

      $5

    )

    ON CONFLICT (month_start)
    DO NOTHING

    RETURNING id, report_data
    `,
    [
      start,
      end,
      JSON.stringify(data),
      pdfBuffer,
      generatedBy
    ]
  );


  if (inserted.rowCount) {

    return {
      created: true,
      report: inserted.rows[0]
    };

  }


  // Another process may have generated it first.

  const raced = await db.query(
    `
    SELECT
      id,
      report_data

    FROM monthly_financial_reports

    WHERE month_start = $1
    `,
    [start]
  );


  return {
    created: false,
    report: raced.rows[0]
  };

}


// =====================================================
// EXPORTS
// =====================================================

module.exports = {

  createMonthlyReport,

  previousMonthStart,

  monthRange,

  validMonth,

  datePartsInDhaka

};
