"use strict";

// =====================================================
// RUBALIA NETWORK
// MONTHLY FINANCIAL REPORT ROUTES
// =====================================================

const express = require("express");

const pool = require("../config/database");

const { authenticateToken } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/admin");

const {
  createMonthlyReport,
  validMonth,
  previousMonthStart
} = require("../services/monthly-financial-report.service");

const router = express.Router();


// =====================================================
// AUTHENTICATION
// =====================================================

router.use(authenticateToken);


// =====================================================
// HELPERS
// =====================================================

function validExpenseDate(value) {

  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    return false;
  }

  const date = new Date(value + "T00:00:00Z");

  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}


function validExpenseAmount(value) {

  const amount = Number(value);

  return (
    Number.isFinite(amount) &&
    amount > 0 &&
    amount <= 999999999999
  );
}


function validExpenseDescription(value) {

  return (
    typeof value === "string" &&
    value.trim().length >= 2 &&
    value.trim().length <= 240
  );
}


const EXPENSE_CATEGORIES = [
  "office",
  "marketing",
  "salary",
  "transport",
  "utilities",
  "other"
];


// =====================================================
// 1. GET COMPANY EXPENSES
// =====================================================

router.get(
  "/expenses",
  requireAdmin,
  async (req, res, next) => {

    try {

      const month = String(
        req.query.month || ""
      ).trim();

      const values = [];

      let where = "";


      if (month) {

        if (!validMonth(month)) {

          return res.status(400).json({
            success: false,
            message: "Invalid month format. Use YYYY-MM."
          });

        }

        values.push(month + "-01");

        where = `
          WHERE
            expense_date >= $1::date

            AND expense_date <
              ($1::date + INTERVAL '1 month')
        `;

      }


      const result = await pool.query(
        `
        SELECT

          id,
          description,
          category,
          amount,
          expense_date,
          created_at

        FROM company_expenses

        ${where}

        ORDER BY
          expense_date DESC,
          id DESC

        LIMIT 250
        `,
        values
      );


      return res.json({

        success: true,

        expenses: result.rows

      });

    } catch (error) {

      next(error);

    }

  }
);


// =====================================================
// 2. ADD COMPANY EXPENSE
// =====================================================

router.post(
  "/expenses",
  requireAdmin,
  async (req, res, next) => {

    try {

      const description =
        typeof req.body?.description === "string"
          ? req.body.description.trim()
          : "";

      const category =
        typeof req.body?.category === "string"
          ? req.body.category.trim().toLowerCase()
          : "other";

      const amount = Number(req.body?.amount);

      const expenseDate =
        String(req.body?.expense_date || "");


      // VALIDATION

      if (!validExpenseDescription(description)) {

        return res.status(400).json({

          success: false,

          message: "Please enter a valid expense description."

        });

      }


      if (!validExpenseAmount(amount)) {

        return res.status(400).json({

          success: false,

          message: "Please enter a valid expense amount."

        });

      }


      if (!EXPENSE_CATEGORIES.includes(category)) {

        return res.status(400).json({

          success: false,

          message: "Invalid expense category."

        });

      }


      if (!validExpenseDate(expenseDate)) {

        return res.status(400).json({

          success: false,

          message: "Invalid expense date."

        });

      }


      // SAVE EXPENSE

      const result = await pool.query(
        `
        INSERT INTO company_expenses (

          description,
          category,
          amount,
          expense_date,
          created_by

        )

        VALUES ($1, $2, $3, $4::date, $5)

        RETURNING

          id,
          description,
          category,
          amount,
          expense_date,
          created_at
        `,
        [
          description,
          category,
          amount.toFixed(2),
          expenseDate,
          req.auth.id
        ]
      );


      return res.status(201).json({

        success: true,

        message: "Company expense saved successfully.",

        expense: result.rows[0]

      });

    } catch (error) {

      next(error);

    }

  }
);


// =====================================================
// 3. GET MONTHLY REPORT ARCHIVE
// =====================================================

router.get(
  "/monthly",
  requireAdmin,
  async (req, res, next) => {

    try {

      const result = await pool.query(
        `
        SELECT

          id,
          month_start,
          month_end,
          report_data,
          generated_at

        FROM monthly_financial_reports

        ORDER BY
          month_start DESC

        LIMIT 60
        `
      );


      return res.json({

        success: true,

        count: result.rowCount,

        reports: result.rows

      });

    } catch (error) {

      next(error);

    }

  }
);


// =====================================================
// 4. MANUALLY GENERATE MONTHLY REPORT
// =====================================================

router.post(
  "/monthly/:month/generate",
  requireAdmin,
  async (req, res, next) => {

    try {

      const month = String(
        req.params.month || ""
      );


      if (!validMonth(month)) {

        return res.status(400).json({

          success: false,

          message: "Month must use YYYY-MM format."

        });

      }


      // DO NOT GENERATE CURRENT OR FUTURE MONTH

      const latestClosedMonth =
        previousMonthStart(new Date()).slice(0, 7);

      if (month > latestClosedMonth) {

        return res.status(400).json({

          success: false,

          message: "Only completed calendar months can be reported."

        });

      }


      const result = await createMonthlyReport(
        pool,
        month,
        req.auth.id
      );


      return res.json({

        success: true,

        created: result.created,

        message: result.created
          ? "Monthly financial PDF generated successfully."
          : "This month's report already exists and was not changed.",

        report: result.report.report_data

      });

    } catch (error) {

      next(error);

    }

  }
);


// =====================================================
// 5. DOWNLOAD MONTHLY PDF
// =====================================================

router.get(
  "/monthly/:month/pdf",
  requireAdmin,
  async (req, res, next) => {

    try {

      const month = String(
        req.params.month || ""
      );


      if (!validMonth(month)) {

        return res.status(400).json({

          success: false,

          message: "Invalid month format."

        });

      }


      const latestClosedMonth =
        previousMonthStart(new Date()).slice(0, 7);

      if (month > latestClosedMonth) {

        return res.status(400).json({

          success: false,

          message: "The requested reporting month is not closed."

        });

      }


      const monthStart = month + "-01";


      // FIND EXISTING PDF

      let result = await pool.query(
        `
        SELECT pdf_data

        FROM monthly_financial_reports

        WHERE month_start = $1::date
        `,
        [monthStart]
      );


      // GENERATE IF NOT AVAILABLE

      if (!result.rowCount) {

        await createMonthlyReport(
          pool,
          month,
          req.auth.id
        );


        result = await pool.query(
          `
          SELECT pdf_data

          FROM monthly_financial_reports

          WHERE month_start = $1::date
          `,
          [monthStart]
        );

      }


      if (!result.rowCount) {

        return res.status(404).json({

          success: false,

          message: "Monthly PDF report not found."

        });

      }


      // SEND PDF

      res.setHeader(
        "Content-Type",
        "application/pdf"
      );

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="rubalia-monthly-financial-${month}.pdf"`
      );

      res.setHeader(
        "Cache-Control",
        "private, no-store"
      );


      return res.send(result.rows[0].pdf_data);

    } catch (error) {

      next(error);

    }

  }
);


// =====================================================
// EXPORT ROUTER
// =====================================================

module.exports = router;
