
"use strict";

const express = require("express");
const crypto = require("crypto");

const pool = require("../config/database");
const { authenticateToken } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/admin");
const { sendAdminPush } = require("../services/admin-push");

const router = express.Router();

const CATEGORIES = [
  "Account & Profile",
  "Product Information",
  "Order & Delivery",
  "Payment & Wallet",
  "Technical Problem",
  "Other"
];

const PRIORITIES = ["low", "normal", "high"];
const STATUSES = [
  "open",
  "in_progress",
  "waiting_member",
  "resolved",
  "closed"
];

function makeTicketReference() {
  return `RBS-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

function cleanMessage(value) {
  return typeof value === "string" ? value.trim() : "";
}

async function getTicketForMember(ticketId, userId) {
  return pool.query(
    `SELECT id, ticket_reference, subject, category, priority,
            status, created_at, updated_at
     FROM support_tickets
     WHERE id = $1 AND user_id = $2`,
    [ticketId, userId]
  );
}

router.use(authenticateToken);

/* MEMBER: CREATE TICKET */
router.post("/tickets", async (req, res, next) => {
  const subject = cleanMessage(req.body?.subject);
  const category = cleanMessage(req.body?.category);
  const priority = cleanMessage(req.body?.priority || "normal").toLowerCase();
  const message = cleanMessage(req.body?.message);

  if (subject.length < 4 || subject.length > 160) {
    return res.status(400).json({
      success: false,
      message: "Subject must be between 4 and 160 characters."
    });
  }

  if (!CATEGORIES.includes(category)) {
    return res.status(400).json({
      success: false,
      message: "Please select a valid support category."
    });
  }

  if (!PRIORITIES.includes(priority)) {
    return res.status(400).json({
      success: false,
      message: "Invalid ticket priority."
    });
  }

  if (message.length < 10 || message.length > 5000) {
    return res.status(400).json({
      success: false,
      message: "Message must be between 10 and 5000 characters."
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const ticketReference = makeTicketReference();

    const ticketResult = await client.query(
      `INSERT INTO support_tickets
        (ticket_reference, user_id, subject, category, priority)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, ticket_reference, subject, category,
                 priority, status, created_at, updated_at`,
      [
        ticketReference,
        req.auth.id,
        subject,
        category,
        priority
      ]
    );

    const ticket = ticketResult.rows[0];

    await client.query(
      `INSERT INTO support_messages
        (ticket_id, sender_id, sender_role, message)
       VALUES ($1, $2, 'member', $3)`,
      [ticket.id, req.auth.id, message]
    );

    await client.query("COMMIT");

    // Notify Admin about a new member support message.
    sendAdminPush("new_message", {
      reference: ticket.ticket_reference,
      message: `A new support message has been received: ${ticket.subject}`
    }).catch(error => {
      console.error("New support ticket Admin push failed:", error.message);
    });

    return res.status(201).json({
      success: true,
      message: "Support ticket created successfully.",
      ticket
    });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
});

/* MEMBER: LIST OWN TICKETS */
router.get("/tickets", async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT
         t.id, t.ticket_reference, t.subject, t.category,
         t.priority, t.status, t.created_at, t.updated_at,
         (SELECT COUNT(*)::INT FROM support_messages m
          WHERE m.ticket_id = t.id) AS message_count,
         (SELECT m.message FROM support_messages m
          WHERE m.ticket_id = t.id
          ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message
       FROM support_tickets t
       WHERE t.user_id = $1
       ORDER BY t.updated_at DESC
       LIMIT 100`,
      [req.auth.id]
    );

    return res.json({ success: true, tickets: result.rows });
  } catch (error) {
    return next(error);
  }
});

/* MEMBER: VIEW OWN TICKET + CONVERSATION */
router.get("/tickets/:id", async (req, res, next) => {
  try {
    const ticketResult = await getTicketForMember(req.params.id, req.auth.id);

    if (!ticketResult.rowCount) {
      return res.status(404).json({
        success: false,
        message: "Support ticket not found."
      });
    }

    const messagesResult = await pool.query(
      `SELECT id, sender_role, message, created_at
       FROM support_messages
       WHERE ticket_id = $1
       ORDER BY created_at ASC, id ASC`,
      [req.params.id]
    );

    return res.json({
      success: true,
      ticket: ticketResult.rows[0],
      messages: messagesResult.rows
    });
  } catch (error) {
    return next(error);
  }
});

/* MEMBER: REPLY TO OWN TICKET */
router.post("/tickets/:id/messages", async (req, res, next) => {
  const message = cleanMessage(req.body?.message);

  if (message.length < 1 || message.length > 5000) {
    return res.status(400).json({
      success: false,
      message: "Message must be between 1 and 5000 characters."
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const ticketResult = await client.query(
      `SELECT id, ticket_reference, subject, status
       FROM support_tickets
       WHERE id = $1 AND user_id = $2
       FOR UPDATE`,
      [req.params.id, req.auth.id]
    );

    if (!ticketResult.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Support ticket not found."
      });
    }

    const ticket = ticketResult.rows[0];

    if (["resolved", "closed"].includes(ticket.status)) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "This ticket is closed. Create a new ticket for further help."
      });
    }

    const inserted = await client.query(
      `INSERT INTO support_messages
        (ticket_id, sender_id, sender_role, message)
       VALUES ($1, $2, 'member', $3)
       RETURNING id, sender_role, message, created_at`,
      [req.params.id, req.auth.id, message]
    );

    await client.query(
      `UPDATE support_tickets
       SET status = 'open', updated_at = NOW()
       WHERE id = $1`,
      [req.params.id]
    );

    await client.query("COMMIT");

    // Notify Admin about a new member reply.
    sendAdminPush("new_message", {
      reference: ticket.ticket_reference,
      message: `A member sent a new message: ${ticket.subject}`
    }).catch(error => {
      console.error("Member message Admin push failed:", error.message);
    });

    return res.status(201).json({
      success: true,
      message: "Reply sent.",
      reply: inserted.rows[0]
    });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
});

/* ADMIN ENDPOINTS: ALL REQUIRE ADMIN ROLE */
router.use("/admin", requireAdmin);

/* ADMIN: LIST ALL TICKETS */
router.get("/admin/tickets", async (req, res, next) => {
  try {
    const status = cleanMessage(req.query.status).toLowerCase();
    const search = cleanMessage(req.query.search).slice(0, 100);

    if (status && !STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid ticket status filter."
      });
    }

    const values = [];
    const conditions = [];

    if (status) {
      values.push(status);
      conditions.push(`t.status = $${values.length}`);
    }

    if (search) {
      values.push(`%${search}%`);
      const p = values.length;
      conditions.push(`(
        t.ticket_reference ILIKE $${p}
        OR t.subject ILIKE $${p}
        OR u.full_name ILIKE $${p}
        OR u.email ILIKE $${p}
      )`);
    }

    const where = conditions.length
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    const result = await pool.query(
      `SELECT
         t.id, t.ticket_reference, t.subject, t.category,
         t.priority, t.status, t.created_at, t.updated_at,
         u.id AS user_id, u.full_name AS member_name,
         u.email AS member_email,
         (SELECT COUNT(*)::INT FROM support_messages m
          WHERE m.ticket_id = t.id) AS message_count
       FROM support_tickets t
       JOIN users u ON u.id = t.user_id
       ${where}
       ORDER BY
         CASE WHEN t.status IN ('open', 'waiting_member') THEN 0 ELSE 1 END,
         t.updated_at DESC
       LIMIT 200`,
      values
    );

    return res.json({ success: true, tickets: result.rows });
  } catch (error) {
    return next(error);
  }
});

/* ADMIN: VIEW TICKET */
router.get("/admin/tickets/:id", async (req, res, next) => {
  try {
    const ticketResult = await pool.query(
      `SELECT
         t.id, t.ticket_reference, t.subject, t.category,
         t.priority, t.status, t.created_at, t.updated_at,
         u.id AS user_id, u.full_name AS member_name,
         u.email AS member_email
       FROM support_tickets t
       JOIN users u ON u.id = t.user_id
       WHERE t.id = $1`,
      [req.params.id]
    );

    if (!ticketResult.rowCount) {
      return res.status(404).json({
        success: false,
        message: "Support ticket not found."
      });
    }

    const messagesResult = await pool.query(
      `SELECT
         m.id, m.sender_role, m.message, m.created_at,
         u.full_name AS sender_name
       FROM support_messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.ticket_id = $1
       ORDER BY m.created_at ASC, m.id ASC`,
      [req.params.id]
    );

    return res.json({
      success: true,
      ticket: ticketResult.rows[0],
      messages: messagesResult.rows
    });
  } catch (error) {
    return next(error);
  }
});

/* ADMIN: REPLY */
router.post("/admin/tickets/:id/messages", async (req, res, next) => {
  const message = cleanMessage(req.body?.message);

  if (message.length < 1 || message.length > 5000) {
    return res.status(400).json({
      success: false,
      message: "Reply must be between 1 and 5000 characters."
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const ticketResult = await client.query(
      `SELECT id, status FROM support_tickets
       WHERE id = $1 FOR UPDATE`,
      [req.params.id]
    );

    if (!ticketResult.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Support ticket not found."
      });
    }

    if (ticketResult.rows[0].status === "closed") {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "This ticket is closed."
      });
    }

    const inserted = await client.query(
      `INSERT INTO support_messages
        (ticket_id, sender_id, sender_role, message)
       VALUES ($1, $2, 'admin', $3)
       RETURNING id, sender_role, message, created_at`,
      [req.params.id, req.auth.id, message]
    );

    await client.query(
      `UPDATE support_tickets
       SET status = 'waiting_member', updated_at = NOW()
       WHERE id = $1`,
      [req.params.id]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "Admin reply sent.",
      reply: inserted.rows[0]
    });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
});

/* ADMIN: CHANGE STATUS */
router.patch("/admin/tickets/:id/status", async (req, res, next) => {
  const status = cleanMessage(req.body?.status).toLowerCase();

  if (!STATUSES.includes(status)) {
    return res.status(400).json({
      success: false,
      message: "Invalid ticket status."
    });
  }

  try {
    const result = await pool.query(
      `UPDATE support_tickets
       SET status = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, ticket_reference, status, updated_at`,
      [status, req.params.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        success: false,
        message: "Support ticket not found."
      });
    }

    return res.json({
      success: true,
      message: "Ticket status updated.",
      ticket: result.rows[0]
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
