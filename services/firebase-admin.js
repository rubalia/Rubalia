"use strict";

const admin = require("firebase-admin");

function getMessaging() {
  if (admin.apps.length) {
    return admin.messaging();
  }

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!raw) {
    throw new Error("Firebase service account is not configured.");
  }

  let serviceAccount;

  try {
    serviceAccount = JSON.parse(raw);
  } catch {
    throw new Error("Invalid Firebase service account JSON.");
  }

  if (
    !serviceAccount.project_id ||
    !serviceAccount.client_email ||
    !serviceAccount.private_key
  ) {
    throw new Error("Firebase service account is incomplete.");
  }

  serviceAccount.private_key =
    serviceAccount.private_key.replace(/\\n/g, "\n");

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: serviceAccount.project_id
  });

  return admin.messaging();
}

async function sendPush(tokens, notification) {
  const messaging = getMessaging();

  const result = {
    successCount: 0,
    failureCount: 0,
    invalidTokens: []
  };

  for (let i = 0; i < tokens.length; i += 500) {
    const batch = tokens.slice(i, i + 500);

    const response = await messaging.sendEachForMulticast({
      tokens: batch,

      notification: {
        title: notification.title,
        body: notification.message
      },

      data: {
        url: "https://rubalia.github.io/Rubalia/"
      },

      android: {
        priority: "high",
        notification: {
          channelId: "rubalia_general",
          sound: "default"
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
