
"use strict";

const pool = require("../config/database");

const {
  sendPush
} = require("./firebase-admin");

/* =====================================================
   RUBALIA NETWORK
   ADMIN EVENT PUSH SERVICE

   Sends important system events to active Admin devices.

   Supported events:
     - new_order
     - new_deposit
     - new_withdrawal
     - new_message

   IMPORTANT:
     Push failure must never interrupt the main
     order, wallet or messaging operation.
===================================================== */

const EVENT_CONFIG = {
  new_order: {
    title: "New Order Received",
    link: "https://rubalia.github.io/Rubalia/admin/orders.html"
  },

  new_deposit: {
    title: "New Deposit Request",
    link: "https://rubalia.github.io/Rubalia/admin/deposits.html"
  },

  new_withdrawal: {
    title: "New Withdrawal Request",
    link: "https://rubalia.github.io/Rubalia/admin/withdrawals.html"
  },

  new_message: {
    title: "New Member Message",
    link: "https://rubalia.github.io/Rubalia/admin/support.html"
  }
};

/* =====================================================
   CLEAN INVALID DEVICE TOKENS
===================================================== */

async function removeInvalidTokens(tokens) {
  if (!Array.isArray(tokens) || !tokens.length) {
    return;
  }

  try {
    await pool.query(
      `DELETE FROM push_devices
       WHERE token = ANY($1::text[])`,
      [tokens]
    );
  } catch (error) {
    console.error(
      "Admin Push: Invalid token cleanup failed:",
      error.message
    );
  }
}

/* =====================================================
   SEND PUSH TO ALL ACTIVE ADMINS

   event:
     new_order
     new_deposit
     new_withdrawal
     new_message

   details:
     Optional additional event information.
===================================================== */

async function sendAdminPush(event, details = {}) {
  try {
    const config = EVENT_CONFIG[event];

    if (!config) {
      console.warn(
        "Admin Push: Unknown event:",
        event
      );

      return {
        success: false,
        reason: "unknown_event"
      };
    }

    /* -----------------------------------------------
       GET ACTIVE ADMIN DEVICE TOKENS
    ----------------------------------------------- */

    const result = await pool.query(
      `SELECT DISTINCT d.token
       FROM push_devices d
       INNER JOIN users u
         ON u.id = d.user_id
       WHERE LOWER(u.role) = 'admin'
         AND LOWER(u.status) = 'active'
         AND d.token IS NOT NULL
         AND d.token <> ''`
    );

    const tokens = result.rows.map(
      row => row.token
    );

    if (!tokens.length) {
      console.log(
        "Admin Push: No registered Admin devices."
      );

      return {
        success: true,
        deviceCount: 0,
        successCount: 0,
        failureCount: 0
      };
    }

    /* -----------------------------------------------
       BUILD MESSAGE
    ----------------------------------------------- */

    const reference = String(
      details.reference || ""
    ).trim();

    let message = String(
      details.message || ""
    ).trim();

    if (!message) {
      const defaults = {
        new_order: "A new customer order has been received.",
        new_deposit: "A new wallet deposit request has been submitted.",
        new_withdrawal: "A new wallet withdrawal request has been submitted.",
        new_message: "A member has sent a new message."
      };

      message = defaults[event];
    }

    if (reference) {
      message += " Reference: " + reference;
    }

    message = message.slice(0, 1000);

    /* -----------------------------------------------
       SEND FIREBASE PUSH
    ----------------------------------------------- */

    const pushResult = await sendPush(
      tokens,
      {
        title: config.title,
        message,
        link: config.link
      }
    );

    /* -----------------------------------------------
       REMOVE INVALID TOKENS
    ----------------------------------------------- */

    if (
      Array.isArray(pushResult.invalidTokens) &&
      pushResult.invalidTokens.length
    ) {
      await removeInvalidTokens(
        pushResult.invalidTokens
      );
    }

    console.log(
      "Admin Push:",
      event,
      "Sent:",
      pushResult.successCount,
      "Failed:",
      pushResult.failureCount
    );

    return {
      success: true,
      deviceCount: tokens.length,
      successCount: pushResult.successCount,
      failureCount: pushResult.failureCount
    };

  } catch (error) {
    console.error(
      "Admin Push delivery failed:",
      error.message
    );

    return {
      success: false,
      reason: "delivery_failed",
      message: error.message
    };
  }
}

/* =====================================================
   EXPORTS
===================================================== */

module.exports = {
  sendAdminPush
};
