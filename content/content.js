// ScenePull content script: floating launcher + passive trend flag + scrape endpoint.
(() => {
  if (window.__scenepullLoaded) return;
  window.__scenepullLoaded = true;

  const S = globalThis.ScenePullScraper;
  const DEFAULT_PREFS = { showFloatingButton: true, trendViewThreshold: 500000, trendVelocityThreshold: 20000 };
  let prefs = { ...DEFAULT_PREFS };
  let btn = null;
  let lastUrl = location.href;

  // ---------- messaging ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "SP_SCRAPE") {
      try {
        sendResponse({ ok: true, data: S.scrapeCurrentPage() });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
      return false;
    }
    if (msg?.type === "SP_PING") {
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  // ---------- floating launcher ----------
  function buildButton() {
    if (btn) return btn;
    btn = document.createElement("div");
    btn.id = "scenepull-fab";
    btn.setAttribute("role", "button");
    btn.setAttribute("tabindex", "0");
    btn.title = "ScenePull: build a brief from this video (drag to move)";
    btn.innerHTML = `
      <span class="sp-fab-logo">SP</span>
      <span class="sp-fab-label">ScenePull</span>
      <span class="sp-fab-flag" hidden></span>`;
    document.documentElement.appendChild(btn);
    restorePosition();
    makeDraggable(btn);
    return btn;
  }

  function restorePosition() {
    chrome.storage.local.get("fabPos").then(({ fabPos }) => {
      if (!fabPos || !btn) return;
      const x = Math.min(Math.max(0, fabPos.x), window.innerWidth - 60);
      const y = Math.min(Math.max(0, fabPos.y), window.innerHeight - 40);
      btn.style.left = x + "px";
      btn.style.top = y + "px";
      btn.style.right = "auto";
      btn.style.bottom = "auto";
    });
  }

  function makeDraggable(el) {
    let startX, startY, origX, origY, moved = false, dragging = false;
    el.addEventListener("pointerdown", (e) => {
      dragging = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      const r = el.getBoundingClientRect();
      origX = r.left;
      origY = r.top;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      if (!moved) return;
      el.style.left = Math.min(Math.max(0, origX + dx), window.innerWidth - el.offsetWidth) + "px";
      el.style.top = Math.min(Math.max(0, origY + dy), window.innerHeight - el.offsetHeight) + "px";
      el.style.right = "auto";
      el.style.bottom = "auto";
    });
    el.addEventListener("pointerup", (e) => {
      dragging = false;
      el.releasePointerCapture(e.pointerId);
      if (moved) {
        const r = el.getBoundingClientRect();
        chrome.storage.local.set({ fabPos: { x: r.left, y: r.top } });
      } else {
        openPanel();
      }
    });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") openPanel();
    });
  }

  function openPanel() {
    chrome.runtime.sendMessage({ type: "SP_OPEN_PANEL" }).catch(() => {});
  }

  // ---------- passive trend flag ----------
  function evaluateTrend() {
    if (!btn) return;
    const flag = btn.querySelector(".sp-fab-flag");
    let data;
    try { data = S.scrapeCurrentPage(); } catch { data = null; }
    if (!data || data.error || !data.views) {
      flag.hidden = true;
      btn.classList.remove("sp-hot");
      return;
    }
    const ageHrs = data.postDate ? Math.max(1, (Date.now() - new Date(data.postDate)) / 36e5) : null;
    const velocity = ageHrs ? data.views / ageHrs : 0;
    const hot = data.views >= prefs.trendViewThreshold || velocity >= prefs.trendVelocityThreshold;
    flag.hidden = !hot;
    btn.classList.toggle("sp-hot", hot);
    if (hot) flag.textContent = "🔥 " + compact(data.views);
  }

  function compact(n) {
    return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
  }

  // ---------- SPA navigation watch ----------
  function onUrlMaybeChanged() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    chrome.runtime.sendMessage({ type: "SP_PAGE_CHANGED", url: location.href }).catch(() => {});
    setTimeout(evaluateTrend, 1200);
  }

  async function init() {
    const { settings } = await chrome.storage.local.get("settings");
    prefs = { ...DEFAULT_PREFS, ...(settings?.prefs || {}) };
    if (prefs.showFloatingButton) buildButton();
    setInterval(onUrlMaybeChanged, 800);
    setInterval(evaluateTrend, 4000);
    setTimeout(evaluateTrend, 1500);
  }

  chrome.storage.onChanged.addListener((changes) => {
    if (!changes.settings) return;
    prefs = { ...DEFAULT_PREFS, ...(changes.settings.newValue?.prefs || {}) };
    if (prefs.showFloatingButton) buildButton();
    else if (btn) { btn.remove(); btn = null; }
  });

  init();
})();
