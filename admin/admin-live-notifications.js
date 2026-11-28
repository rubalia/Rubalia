
"use strict";

/*
=====================================================
 RUBALIA NETWORK
 ADMIN LIVE PUSH NOTIFICATION POPUP
=====================================================
 Listens for:
 rubalia:push-received

 Displays notifications while the Admin Dashboard
 is open in the foreground.
=====================================================
*/

(function RubaliaAdminLiveNotifications() {

  const STYLE_ID = "rubalia-admin-live-notification-style";
  const ROOT_ID = "rubalia-admin-live-notification-root";

  let notificationCount = 0;
  let audioContext = null;

  /* -----------------------------------------------
     CREATE STYLES
  ----------------------------------------------- */

  function addStyles() {

    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;

    style.textContent = `
      #${ROOT_ID}{
        position:fixed;
        top:76px;
        right:16px;
        z-index:99999;
        width:min(370px,calc(100vw - 24px));
        pointer-events:none;
      }

      .rubalia-live-popup{
        pointer-events:auto;
        background:#ffffff;
        border:1px solid #e4e9f0;
        border-left:4px solid #d6ad55;
        border-radius:12px;
        box-shadow:0 12px 35px rgba(7,26,53,.18);
        margin-bottom:10px;
        overflow:hidden;
        animation:rubaliaPopupIn .25s ease;
      }

      .rubalia-live-popup-head{
        display:flex;
        align-items:center;
        gap:10px;
        padding:12px 13px 9px;
      }

      .rubalia-live-popup-icon{
        width:37px;
        height:37px;
        flex-shrink:0;
        display:grid;
        place-items:center;
        border-radius:10px;
        background:#071a35;
        color:#d6ad55;
        font-size:19px;
      }

      .rubalia-live-popup-heading{
        min-width:0;
        flex:1;
      }

      .rubalia-live-popup-heading strong{
        display:block;
        color:#071a35;
        font-size:12px;
        line-height:1.4;
        overflow-wrap:anywhere;
      }

      .rubalia-live-popup-heading small{
        display:block;
        color:#8793a5;
        font-size:9px;
        margin-top:3px;
      }

      .rubalia-live-popup-close{
        width:27px;
        height:27px;
        border:0;
        border-radius:7px;
        background:#f1f4f8;
        color:#68768a;
        font-size:17px;
        cursor:pointer;
        flex-shrink:0;
      }

      .rubalia-live-popup-message{
        padding:0 13px 12px 60px;
        color:#526176;
        font-size:11px;
        line-height:1.6;
        overflow-wrap:anywhere;
        white-space:pre-wrap;
      }

      .rubalia-live-popup-actions{
        display:flex;
        justify-content:flex-end;
        gap:7px;
        padding:9px 12px;
        border-top:1px solid #edf0f5;
        background:#fafbfd;
      }

      .rubalia-live-popup-action{
        border:0;
        border-radius:7px;
        padding:8px 11px;
        font-size:10px;
        font-weight:bold;
        cursor:pointer;
      }

      .rubalia-live-popup-open{
        background:#071a35;
        color:#ffffff;
      }

      .rubalia-live-popup-dismiss{
        background:#edf1f6;
        color:#526176;
      }

      @keyframes rubaliaPopupIn{
        from{
          opacity:0;
          transform:translateY(-10px);
        }
        to{
          opacity:1;
          transform:translateY(0);
        }
      }

      @media(max-width:480px){
        #${ROOT_ID}{
          top:65px;
          right:8px;
          width:calc(100vw - 16px);
        }
      }

      @media(prefers-reduced-motion:reduce){
        .rubalia-live-popup{
          animation:none;
        }
      }
    `;

    document.head.appendChild(style);
  }

  /* -----------------------------------------------
     CREATE POPUP ROOT
  ----------------------------------------------- */

  function getRoot() {

    let root = document.getElementById(ROOT_ID);

    if (!root) {
      root = document.createElement("div");
      root.id = ROOT_ID;
      root.setAttribute("aria-live", "polite");
      root.setAttribute("aria-relevant", "additions");
      document.body.appendChild(root);
    }

    return root;
  }

  /* -----------------------------------------------
     SAFE URL
  ----------------------------------------------- */

  function getSafeLink(notification) {

    const raw =
      notification?.data?.url ||
      notification?.data?.link ||
      notification?.notification?.data?.url ||
      notification?.link ||
      "";

    if (typeof raw !== "string" || !raw.trim()) {
      return "";
    }

    try {

      const url = new URL(raw, location.origin);

      if (url.protocol !== "https:" && url.origin !== location.origin) {
        return "";
      }

      return url.href;

    } catch (error) {
      return "";
    }
  }

  /* -----------------------------------------------
     EXTRACT NOTIFICATION CONTENT
  ----------------------------------------------- */

  function extractNotification(notification) {

    const data =
      notification?.notification ||
      notification?.data ||
      notification ||
      {};

    const title =
      data.title ||
      notification?.title ||
      "RUBALIA NETWORK";

    const message =
      data.body ||
      data.message ||
      notification?.body ||
      notification?.message ||
      "You have received a new notification.";

    return {
      title: String(title).slice(0, 200),
      message: String(message).slice(0, 1000),
      link: getSafeLink(notification)
    };
  }

  /* -----------------------------------------------
     OPTIONAL NOTIFICATION SOUND
  ----------------------------------------------- */

  function playNotificationSound() {

    try {

      const AudioContextClass =
        window.AudioContext || window.webkitAudioContext;

      if (!AudioContextClass) return;

      if (!audioContext) {
        audioContext = new AudioContextClass();
      }

      if (audioContext.state === "suspended") {
        audioContext.resume().catch(() => {});
      }

      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();

      oscillator.type = "sine";
      oscillator.frequency.value = 880;

      gain.gain.setValueAtTime(
        0.0001,
        audioContext.currentTime
      );

      gain.gain.exponentialRampToValueAtTime(
        0.08,
        audioContext.currentTime + 0.02
      );

      gain.gain.exponentialRampToValueAtTime(
        0.0001,
        audioContext.currentTime + 0.22
      );

      oscillator.connect(gain);
      gain.connect(audioContext.destination);

      oscillator.start();
      oscillator.stop(audioContext.currentTime + 0.23);

    } catch (error) {
      // Sound is optional. Popup still works.
    }
  }

  /* -----------------------------------------------
     CREATE ONE POPUP
  ----------------------------------------------- */

  function showPopup(notification) {

    addStyles();

    const root = getRoot();
    const content = extractNotification(notification);

    notificationCount++;

    const card = document.createElement("section");
    card.className = "rubalia-live-popup";

    const header = document.createElement("div");
    header.className = "rubalia-live-popup-head";

    const icon = document.createElement("div");
    icon.className = "rubalia-live-popup-icon";
    icon.textContent = "R";

    const heading = document.createElement("div");
    heading.className = "rubalia-live-popup-heading";

    const title = document.createElement("strong");
    title.textContent = content.title;

    const time = document.createElement("small");
    time.textContent = "RUBALIA NETWORK · Just now";

    heading.append(title, time);

    const close = document.createElement("button");
    close.type = "button";
    close.className = "rubalia-live-popup-close";
    close.textContent = "×";
    close.setAttribute("aria-label", "Close notification");

    close.addEventListener("click", () => {
      card.remove();
    });

    header.append(icon, heading, close);

    const message = document.createElement("div");
    message.className = "rubalia-live-popup-message";
    message.textContent = content.message;

    const actions = document.createElement("div");
    actions.className = "rubalia-live-popup-actions";

    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className =
      "rubalia-live-popup-action rubalia-live-popup-dismiss";
    dismiss.textContent = "Dismiss";

    dismiss.addEventListener("click", () => {
      card.remove();
    });

    actions.appendChild(dismiss);

    if (content.link) {

      const open = document.createElement("button");

      open.type = "button";
      open.className =
        "rubalia-live-popup-action rubalia-live-popup-open";

      open.textContent = "Open";

      open.addEventListener("click", () => {
        window.location.href = content.link;
      });

      actions.appendChild(open);
    }

    card.append(header, message, actions);

    root.prepend(card);

    // Keep only the latest 5 visible popups.
    while (root.children.length > 5) {
      root.lastElementChild.remove();
    }

    playNotificationSound();

    // Automatically close after 12 seconds.
    window.setTimeout(() => {
      if (card.isConnected) {
        card.remove();
      }
    }, 12000);

    window.dispatchEvent(
      new CustomEvent("rubalia:admin-popup-shown", {
        detail: {
          count: notificationCount,
          title: content.title
        }
      })
    );
  }

  /* -----------------------------------------------
     LISTEN FOR FIREBASE PUSH EVENTS
  ----------------------------------------------- */

  function initialize() {

    if (window.__rubaliaAdminPopupInitialized) {
      return;
    }

    window.__rubaliaAdminPopupInitialized = true;

    addStyles();
    getRoot();

    window.addEventListener(
      "rubalia:push-received",
      event => {

        if (!event.detail) return;

        showPopup(event.detail);

      }
    );

    console.log(
      "RUBALIA Admin Live Notification Popup initialized."
    );
  }

  /* -----------------------------------------------
     START
  ----------------------------------------------- */

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
