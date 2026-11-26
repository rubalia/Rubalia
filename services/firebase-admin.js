
"use strict";

const admin = require("firebase-admin");

const DEFAULT_NOTIFICATION_URL =
  "https://rubalia.github.io/Rubalia/";

/**
 * Firebase Messaging initialize
 */
function getMessaging() {
  if (admin.apps.length) {
    return admin.messaging();
  }

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!raw) {
    throw new Error(
      "Firebase service account is not configured."
    );
  }

  let serviceAccount;

  try {
    serviceAccount = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      "Invalid Firebase service account JSON."
    );
  }

  if (
    !serviceAccount.project_id ||
    !serviceAccount.client_email ||
    !serviceAccount.private_key
  ) {
    throw new Error(
      "Firebase service account is incomplete."
    );
  }

  serviceAccount.private_key =
    serviceAccount.private_key.replace(/\\n/g, "\n");

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: serviceAccount.project_id
  });

  return admin.messaging();
}

/**
 * Validate notification link
 * Only HTTPS links are accepted.
 */
function getNotificationUrl(link) {
  if (!link || typeof link !== "string") {
    return DEFAULT_NOTIFICATION_URL;
  }

  try {
    const parsed = new URL(link.trim());

    if (parsed.protocol !== "https:") {
      return DEFAULT_NOTIFICATION_URL;
    }

    return parsed.toString();
  } catch (error) {
    return DEFAULT_NOTIFICATION_URL;
  }
}

/**
 * Send Push Notifications
 *
 * tokens: Firebase device tokens
 * notification:
 * {
 *   title: "Notification title",
 *   message: "Notification message",
 *   link: "https://example.com"
 * }
 */
async function sendPush(tokens, notification = {}) {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    return {
      successCount: 0,
      failureCount: 0,
      invalidTokens: []
    };
  }

  const title = String(notification.title || "RUBALIA NETWORK")
    .trim()
    .slice(0, 180);

  const message = String(notification.message || "")
    .trim()
    .slice(0, 1000);

  if (!title || !message) {
    throw new Error(
      "Notification title and message are required."
    );
  }

  const targetUrl = getNotificationUrl(notification.link);

  const messaging = getMessaging();

  const result = {
    successCount: 0,
    failureCount: 0,
    invalidTokens: []
  };

  // Firebase supports maximum 500 tokens per batch.
  for (let i = 0; i < tokens.length; i += 500) {
    const batch = tokens
      .slice(i, i + 500)
      .filter(token => typeof token === "string" && token.trim());

    if (batch.length === 0) {
      continue;
    }

    const response = await messaging.sendEachForMulticast({
      tokens: batch,

      notification: {
        title,
        body: message
      },

      // App can read this URL when the notification is clicked.
      data: {
        url: targetUrl
      },

      android: {
        priority: "high",
        notification: {
          channelId: "rubalia_general",
          sound: "default"
        }
      },

      webpush: {
        notification: {
          title,
          body: message,
          icon: "https://rubalia.github.io/Rubalia/assets/icon.png"
        },

        fcmOptions: {
          link: targetUrl
        }
      }
    });

    result.successCount += response.successCount;
    result.failureCount += response.failureCount;

    response.responses.forEach((item, index) => {
      if (
        !item.success &&
        item.error &&
        [
          "messaging/registration-token-not-registered",
          "messaging/invalid-registration-token"
        ].includes(item.error.code)
      ) {
        result.invalidTokens.push(batch[index]);
      }
    });
  }

  return result;
}

module.exports = {
  getMessaging,
  sendPush
};
