"use strict";

const pool = require("../config/database");

async function runMonthlyFinancialReportMigration() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // ================================================
    // COMPANY EXPENSES
    // ================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS company_expenses (

        id BIGSERIAL PRIMARY KEY,

        description VARCHAR(240) NOT NULL,

        category VARCHAR(80) NOT NULL DEFAULT 'other',

        amount NUMERIC(14,2) NOT NULL,

        expense_date DATE NOT NULL,

        created_by BIGINT
          REFERENCES users(id)
          ON DELETE SET NULL,

        created_at TIMESTAMPTZ
          NOT NULL DEFAULT NOW(),

        CONSTRAINT company_expenses_amount_positive
          CHECK (amount > 0)

      );
    `);

    // Expense date index

    await client.query(`
      CREATE INDEX IF NOT EXISTS
        idx_company_expenses_date

      ON company_expenses(expense_date DESC);
    `);


    // ================================================
    // MONTHLY FINANCIAL REPORTS
    // ================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS monthly_financial_reports (

        id BIGSERIAL PRIMARY KEY,

        month_start DATE NOT NULL UNIQUE,

        month_end DATE NOT NULL,

        report_data JSONB NOT NULL,

        pdf_data BYTEA NOT NULL,

        generated_at TIMESTAMPTZ
          NOT NULL DEFAULT NOW(),

        generated_by BIGINT
          REFERENCES users(id)
          ON DELETE SET NULL,

        CONSTRAINT monthly_report_date_valid
          CHECK (month_end >= month_start)

      );
    `);


    // Monthly report index

    await client.query(`
      CREATE INDEX IF NOT EXISTS
        idx_monthly_financial_reports_month

      ON monthly_financial_reports(month_start DESC);
    `);


    // ================================================
    // COMMIT
    // ================================================

    await client.query("COMMIT");

    console.log(
      "Monthly financial report migration completed."
    );

    console.log(
      "Company expenses table ready."
    );

    console.log(
      "Monthly financial reports table ready."
    );

  } catch (error) {

    await client.query("ROLLBACK");

    console.error(
      "Monthly financial report migration failed:",
      error.message
    );

    throw error;

  } finally {

    client.release();

  }
}

module.exports = {
  runMonthlyFinancialReportMigration
};
