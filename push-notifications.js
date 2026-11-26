"use strict";

/*
=====================================================
 RUBALIA NETWORK
 FIREBASE PUSH NOTIFICATION CLIENT
=====================================================

 Android Package:
 com.rubalia.network

 Backend:
 https://rubalia.onrender.com/api

 Website:
 https://rubalia.github.io/Rubalia/

 Requires:
 @capacitor/core 7.x
 @capacitor/push-notifications 7.x
=====================================================
*/

(async function RubaliaPushNotifications() {

  const API_BASE = "https://rubalia.onrender.com/api";

  const WEBSITE_URL = "https://rubalia.github.io/Rubalia/";

  const TOKEN_KEY = "rubalia_token";

  let PushNotifications = null;

  let currentFCMToken = null;

  let initialized = false;

  /* =================================================
     CHECK LOGIN SESSION
  ================================================= */

  function getAuthToken() {
    try {
      return sessionStorage.getItem(TOKEN_KEY) || "";
    } catch (error) {
      console.error("Rubalia session access failed:", error);
      return "";
    }
  }

  /* =================================================
     API REQUEST
  ================================================= */

  async function apiRequest(endpoint, options = {}) {

    const authToken = getAuthToken();

    if (!authToken) {
      throw new Error("Member login required.");
    }

    const response = await fetch(API_BASE + endpoint, {
      ...options,

      headers: {
        "Authorization": "Bearer " + authToken,
        "Content-Type": "application/json",
        "Accept": "application/json",
        ...(options.headers || {})
      }
    });

    let data = {};

    try {
      data = await response.json();
    } catch (error) {
      data = {};
    }

    if (!response.ok) {
      throw new Error(
        data.message || "Rubalia API request failed."
      );
    }

    return data;
  }

  /* =================================================
     SAVE FCM TOKEN TO BACKEND
  ================================================= */

  async function registerDeviceToken(token) {

    if (!token || typeof token !== "string") {
      throw new Error("Invalid Firebase device token.");
    }

    const result = await apiRequest("/push/device-token", {
      method: "POST",

      body: JSON.stringify({
        token: token,
        platform: "android"
      })
    });

    currentFCMToken = token;

    try {
      localStorage.setItem(
        "rubalia_fcm_registered",
        "true"
      );
    } catch (error) {
      // Registration does not depend on local storage.
    }

    console.log(
      "Rubalia FCM device registration successful."
    );

    return result;
  }

  /* =================================================
     REMOVE DEVICE TOKEN
  ================================================= */

  async function removeDeviceToken() {

    if (!currentFCMToken) {
      return;
    }

    try {

      await apiRequest("/push/device-token", {
        method: "DELETE",

        body: JSON.stringify({
          token: currentFCMToken
        })
      });

      currentFCMToken = null;

      console.log("Rubalia device token removed.");

    } catch (error) {

      console.error(
        "Unable to remove Rubalia device token:",
        error.message
      );

    }
  }

  /* =================================================
     NOTIFICATION RECEIVED
  ================================================= */

  async function handleNotificationReceived(notification) {

    console.log(
      "Rubalia notification received:",
      notification
    );

    window.dispatchEvent(
      new CustomEvent("rubalia:push-received", {
        detail: notification
      })
    );
  }

  /* =================================================
     NOTIFICATION CLICKED
  ================================================= */

  function handleNotificationAction(action) {

    console.log(
      "Rubalia notification opened:",
      action
    );

    const targetURL =
      action?.notification?.data?.url;

    if (
      typeof targetURL === "string" &&
      targetURL.startsWith(WEBSITE_URL)
    ) {
      window.location.href = targetURL;
      return;
    }

    window.location.href = WEBSITE_URL;
  }

  /* =================================================
     INITIALIZE PUSH NOTIFICATIONS
  ================================================= */

  async function initialize() {

    if (initialized) {
      return;
    }

    const authToken = getAuthToken();

    if (!authToken) {
      console.log(
        "Rubalia Push: Waiting for member login."
      );
      return;
    }

    try {

      /* ---------------------------------------------
         LOAD CAPACITOR CORE
      --------------------------------------------- */

      const coreModule = await import(
        "https://esm.sh/@capacitor/core@7.4.3"
      );

      const Capacitor = coreModule.Capacitor;

      const registerPlugin = coreModule.registerPlugin;

      if (
        !Capacitor ||
        !Capacitor.isNativePlatform()
      ) {
        console.log(
          "Rubalia Push is available only inside the native app."
        );
        return;
      }

      if (
        Capacitor.getPlatform() !== "android"
      ) {
        console.log(
          "Rubalia Push: Android platform required."
        );
        return;
      }

      /* ---------------------------------------------
         REGISTER NATIVE PLUGIN
      --------------------------------------------- */

      PushNotifications = registerPlugin(
        "PushNotifications"
      );

      /* ---------------------------------------------
         LISTEN FOR FCM TOKEN
      --------------------------------------------- */

      await PushNotifications.addListener(
        "registration",
        async (data) => {

          if (!data || !data.value) {
            console.error(
              "Rubalia received an empty FCM token."
            );
            return;
          }

          console.log(
            "Rubalia FCM token received."
          );

          try {

            await registerDeviceToken(data.value);

          } catch (error) {

            console.error(
              "Rubalia token registration failed:",
              error.message
            );

          }
        }
      );

      /* ---------------------------------------------
         REGISTRATION ERROR
      --------------------------------------------- */

      await PushNotifications.addListener(
        "registrationError",
        (error) => {

          console.error(
            "Rubalia FCM registration error:",
            error
          );

        }
      );

      /* ---------------------------------------------
         NOTIFICATION RECEIVED
      --------------------------------------------- */

      await PushNotifications.addListener(
        "pushNotificationReceived",
        handleNotificationReceived
      );

      /* ---------------------------------------------
         NOTIFICATION CLICKED
      --------------------------------------------- */

      await PushNotifications.addListener(
        "pushNotificationActionPerformed",
        handleNotificationAction
      );

      /* ---------------------------------------------
         CREATE ANDROID NOTIFICATION CHANNEL
      --------------------------------------------- */

      try {

        await PushNotifications.createChannel({
          id: "rubalia_general",
          name: "Rubalia Notifications",
          description: "Rubalia account updates and announcements",
          importance: 5,
          visibility: 1,
          sound: "default",
          vibration: true
        });

      } catch (error) {

        console.warn(
          "Rubalia notification channel:",
          error.message
        );

      }

      /* ---------------------------------------------
         REQUEST NOTIFICATION PERMISSION
      --------------------------------------------- */

      const permission =
        await PushNotifications.requestPermissions();

      if (permission.receive !== "granted") {

        console.warn(
          "Rubalia notification permission denied."
        );

        window.dispatchEvent(
          new CustomEvent("rubalia:push-permission-denied")
        );

        return;
      }

      console.log(
        "Rubalia notification permission granted."
      );

      /* ---------------------------------------------
         REGISTER WITH FIREBASE
      --------------------------------------------- */

      initialized = true;

      await PushNotifications.register();

      console.log(
        "Rubalia Firebase registration requested."
      );

    } catch (error) {

      console.error(
        "Rubalia Push initialization failed:",
        error
      );

      window.dispatchEvent(
        new CustomEvent("rubalia:push-error", {
          detail: {
            message: error.message
          }
        })
      );

    }
  }

  /* =================================================
     PUBLIC API
  ================================================= */

  window.RubaliaPush = {

    initialize,

    removeDeviceToken,

    getCurrentToken() {
      return currentFCMToken;
    }

  };

  /* =================================================
     START
  ================================================= */

  if (document.readyState === "loading") {

    document.addEventListener(
      "DOMContentLoaded",
      initialize,
      { once: true }
    );

  } else {

    initialize();

  }

})();
