// ScenePull service worker
// - Clicking the toolbar icon opens the side panel (not a popup).
// - The floating in-page button asks us to open the panel for its tab.
// - Relays "page changed" pings from content scripts to the side panel.

chrome.runtime.onInstalled.addListener(async (details) => {
  await chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
  if (details.reason === "install") {
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "SP_OPEN_PANEL" && sender.tab) {
    // Must be called synchronously inside the user-gesture message handler.
    chrome.sidePanel
      .open({ tabId: sender.tab.id, windowId: sender.tab.windowId })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg?.type === "SP_OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === "SP_CAPTURE_TAB") {
    // Screenshot of the visible tab, used as a "frame" for vision models.
    chrome.tabs
      .captureVisibleTab(msg.windowId ?? null, { format: "jpeg", quality: 80 })
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  return false;
});
