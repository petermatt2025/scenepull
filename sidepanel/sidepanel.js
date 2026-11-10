import {
  getSettings, saveSettings, saveCharacterProfile, setActiveProfile,
  appendToHistory, getHistory, deleteHistoryEntry, clearHistory,
} from "../lib/storage.js";
import { PROVIDERS, listModels } from "../lib/providers.js";
import { generateBrief, regenerateCopy } from "../lib/briefer.js";
import {
  formatNumber, timeAgo, formatDate, computeTrend, copyToClipboard,
  downloadTextFile, briefToPlainText, escapeHtml, slug, generateId,
} from "../lib/utils.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const STEP_NAMES = ["Capture", "Character", "Brief", "Produce", "Publish"];
const MAX_FRAMES = 3;

// Working state for the current brief (persisted so closing the panel loses nothing).
let state = {
  id: null,
  step: 0,
  scraped: null,
  frames: [], // { mime, data }
  notes: "",
  targetPlatform: "auto",
  extraDirection: "",
  brief: null,
  chosenHook: 0,
  checks: {},
};
let settings = null;
let tab = null;
let abort = null;

// ------------------------------------------------------------------ boot
init();

async function init() {
  settings = await getSettings();
  applyTheme();
  const { draft } = await chrome.storage.local.get("draft");
  if (draft) state = { ...state, ...draft };
  bindUI();
  await refreshTab();
  if (!state.scraped && isSupported(tab?.url)) await scan({ autoFrame: true });
  renderAll();
  goto(state.step);
}

function applyTheme() {
  const t = settings.prefs.theme;
  if (t === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  document.body.classList.toggle("compact", !!settings.prefs.compact);
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.local.set({ draft: state }), 250);
}

function setStatus(id, html, ok = false) {
  const el = $("#" + id);
  if (!el) return;
  el.innerHTML = html || "";
  el.classList.toggle("ok", ok);
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), 3000);
}

// ------------------------------------------------------------------ tab / page
function isSupported(url) {
  return /^https:\/\/www\.(tiktok|instagram)\.com\//.test(url || "");
}

async function refreshTab() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  tab = t || null;
  const chip = $("#platformChip");
  if (isSupported(tab?.url)) {
    chip.textContent = tab.url.includes("tiktok") ? "TikTok" : "Instagram";
    chip.classList.add("live");
  } else {
    chip.textContent = "No video";
    chip.classList.remove("live");
  }
}

async function sendToTab(msg) {
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    // Content script missing (tab was open before install) — inject and retry.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["lib/scraper.js", "content/content.js"] });
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content/content.css"] }).catch(() => {});
    return await chrome.tabs.sendMessage(tab.id, msg);
  }
}

async function scan({ autoFrame = false } = {}) {
  await refreshTab();
  if (!isSupported(tab?.url)) {
    renderCapture();
    return;
  }
  const btn = $("#btnScan");
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "Reading…";
  setStatus("scanStatus", "");
  try {
    const res = await sendToTab({ type: "SP_SCRAPE" });
    if (!res?.ok || res.data?.error) throw new Error(res?.error || res?.data?.error || "Could not read page");
    const sameVideo = state.scraped && state.scraped.videoUrl === res.data.videoUrl;
    if (!sameVideo) {
      state = { ...state, id: null, frames: [], brief: null, checks: {}, chosenHook: 0, notes: "" };
    }
    state.scraped = res.data;
    $("#pageChanged").classList.add("hidden");
    if (autoFrame && settings.prefs.captureFrame && !state.frames.length) await grabFrame({ silent: true });
    persist();
    renderAll();
    const d = res.data;
    const found = ["views", "likes", "comments"].filter((k) => d[k] != null).length;
    if (!found) {
      setStatus("scanStatus",
        d.platform === "instagram"
          ? "Couldn't read the numbers for this Reel. Make sure you're logged in to Instagram, then <b>refresh the page (F5)</b> and press Capture again."
          : "Couldn't read the numbers on this page. <b>Refresh the page (F5)</b> and press Capture again.");
      toast("Captured, but no stats found");
    } else {
      toast(sameVideo ? "Stats refreshed" : "Video captured");
    }
  } catch (e) {
    setStatus("scanStatus", "ScenePull couldn't talk to this page. <b>Refresh the page (F5)</b>, then press Capture again.");
    toast("Couldn't read this page — refresh it");
    console.warn("[ScenePull] scan failed", e);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function grabFrame({ silent = false } = {}) {
  await refreshTab();
  if (!isSupported(tab?.url)) return;
  if (state.frames.length >= MAX_FRAMES) {
    if (!silent) toast(`Max ${MAX_FRAMES} frames — remove one first`);
    return;
  }
  let dataUrl = null;
  // 1) Straight from the video player: cleanest image, needs no extra permission.
  const v = await sendToTab({ type: "SP_VIDEO_FRAME", max: 1280 }).catch(() => null);
  if (v?.ok) dataUrl = v.dataUrl;
  // 2) Screenshot of the visible tab: Chrome only allows this after the toolbar icon is clicked.
  if (!dataUrl) {
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 80 });
    } catch {
      const r = await chrome.runtime.sendMessage({ type: "SP_CAPTURE_TAB", windowId: tab.windowId }).catch(() => null);
      dataUrl = r?.ok ? r.dataUrl : null;
    }
  }
  if (!dataUrl) {
    if (!silent) {
      setStatus("frameStatus",
        v?.error === "no-video"
          ? "No playing video found. Let the video load and play for a second, then press <b>Grab frame</b> again."
          : "Chrome blocked the screenshot. Click the <b>ScenePull icon in the Chrome toolbar</b> (puzzle-piece menu → ScenePull) once while this video is open, then press <b>Grab frame</b> again.");
      toast("Couldn't grab a frame — see the note below");
    }
    return;
  }
  setStatus("frameStatus", "");
  const frame = await downscale(dataUrl, 1280);
  state.frames.push(frame);
  persist();
  renderFrames();
  if (!silent) toast("Frame added");
}

function downscale(dataUrl, max) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      const url = c.toDataURL("image/jpeg", 0.8);
      resolve({ mime: "image/jpeg", data: url.split(",")[1] });
    };
    img.onerror = () => resolve({ mime: "image/jpeg", data: dataUrl.split(",")[1] });
    img.src = dataUrl;
  });
}

// ------------------------------------------------------------------ navigation
function goto(step) {
  state.step = Math.max(0, Math.min(4, step));
  $$(".steps button").forEach((b) => b.setAttribute("aria-selected", String(Number(b.dataset.step) === state.step)));
  $$(".step").forEach((s) => s.classList.toggle("active", Number(s.dataset.step) === state.step));
  updateFooter();
  markDone();
  if (state.step === 2) renderBriefStep();
  $("#main").scrollTop = 0;
  persist();
}

function updateFooter() {
  $("#btnBack").disabled = state.step === 0;
  $("#btnNext").textContent = state.step === 4 ? "New brief ＋" : state.step === 2 && !state.brief ? "Generate ✨" : "Next →";
  $("#stepLabel").textContent = `Step ${state.step + 1} of 5 · ${STEP_NAMES[state.step]}`;
}

function markDone() {
  const done = [
    !!state.scraped,
    !!currentProfile(),
    !!state.brief,
    !!state.brief && ["img", "pick", "anim"].every((k) => state.checks["p_" + k]),
    !!state.brief && ["post"].every((k) => state.checks["u_" + k]),
  ];
  $$(".steps button").forEach((b, i) => b.classList.toggle("done", done[i] && Number(b.dataset.step) !== state.step));
}

// ------------------------------------------------------------------ rendering
function renderAll() {
  renderCapture();
  renderCharacter();
  renderBriefStep();
  renderProduce();
  renderPublish();
  markDone();
  updateFooter();
}

function renderCapture() {
  const supported = isSupported(tab?.url) || !!state.scraped;
  $("#unsupported").classList.toggle("hidden", supported);
  $("#captureBody").classList.toggle("hidden", !supported);
  const s = state.scraped;
  $("#notes").value = state.notes || "";
  if (!s) {
    $("#signals").innerHTML = `<p class="muted small">Press <b>Capture</b> to read this video's stats.</p>`;
    $("#source").innerHTML = "";
    $("#trendPill").textContent = "—";
    $("#trendPill").className = "pill";
    renderFrames();
    return;
  }
  const t = computeTrend(s, settings.prefs);
  const sig = (k, v, tip) => `<div class="sig" ${tip ? `title="${escapeHtml(tip)}"` : ""}><div class="v">${v}</div><div class="k">${k}</div></div>`;
  $("#signals").innerHTML = [
    sig("Views", formatNumber(s.views), s.views == null ? "Not shown on this page (Instagram often hides plays)" : ""),
    sig("Likes", formatNumber(s.likes)),
    sig("Comments", formatNumber(s.comments)),
    s.shares != null ? sig("Shares", formatNumber(s.shares)) : "",
    sig("Posted", timeAgo(s.postDate), formatDate(s.postDate)),
    sig("Views / hr", t.velocity ? formatNumber(Math.round(t.velocity)) : "—", "Views divided by hours since posting"),
    sig("Engagement", t.engagement ? (t.engagement * 100).toFixed(1) + "%" : "—", "Weighted likes + comments + shares + saves per view"),
  ].join("");
  $("#trendPill").textContent = (t.level === "hot" ? "🔥 " : "") + t.label;
  $("#trendPill").className = "pill " + t.level;
  const tags = (s.hashtags || []).slice(0, 10).map((h) => `<span class="pill">#${escapeHtml(h)}</span>`).join("");
  $("#source").innerHTML = `
    <div class="row between"><b>@${escapeHtml(s.authorHandle || "unknown")}</b>
      <a class="small" href="${escapeHtml(s.videoUrl)}" target="_blank">open ↗</a></div>
    ${s.caption ? `<div class="cap">${escapeHtml(s.caption)}</div>` : ""}
    ${s.music ? `<div class="small muted">♪ ${escapeHtml(s.music)}</div>` : ""}
    ${tags ? `<div class="tags" style="margin-top:6px">${tags}</div>` : ""}`;
  renderFrames();
}

function renderFrames() {
  const el = $("#frames");
  if (!state.frames.length) {
    el.innerHTML = `<p class="muted small" style="grid-column:1/-1">No frames yet. Pause on the key moment and press <b>Grab frame</b>.</p>`;
  } else {
    el.innerHTML = state.frames
      .map((f, i) => `<div class="frame"><img src="data:${f.mime};base64,${f.data}" alt="Frame ${i + 1}"><button data-rm="${i}" title="Remove frame">✕</button></div>`)
      .join("");
  }
  $("#btnFrame").disabled = state.frames.length >= MAX_FRAMES;
}

function currentProfile() {
  return settings.profiles.find((p) => p.id === settings.activeProfileId) || settings.profiles[0] || null;
}

function renderCharacter() {
  const sel = $("#charSelect");
  const has = settings.profiles.length > 0;
  $("#quickChar").classList.toggle("hidden", has);
  sel.classList.toggle("hidden", !has);
  sel.innerHTML = settings.profiles.map((p) => `<option value="${p.id}">${escapeHtml(p.name || "Unnamed")}</option>`).join("");
  const p = currentProfile();
  if (p) sel.value = p.id;
  $("#charCard").innerHTML = p
    ? `<dl>
        <dt>Appearance</dt><dd>${escapeHtml(p.appearance || "—")}</dd>
        <dt>Personality</dt><dd>${escapeHtml(p.personality || "—")}</dd>
        <dt>Setting</dt><dd>${escapeHtml(p.recurringSet || "—")}</dd>
        ${p.style ? `<dt>Style</dt><dd>${escapeHtml(p.style)}</dd>` : ""}
        ${p.niche ? `<dt>Niche</dt><dd>${escapeHtml(p.niche)}</dd>` : ""}
      </dl>`
    : `<p class="muted small">No character yet — create one below.</p>`;
  $("#targetPlatform").value = state.targetPlatform || "auto";
  $("#extraDirection").value = state.extraDirection || "";
}

function modelOptions(provider) {
  const cached = settings.modelLists?.[provider]?.items;
  const list = cached?.length ? cached : PROVIDERS[provider].fallbackModels;
  const current = settings.models[provider];
  const items = [...list];
  if (current && !items.find((m) => m.id === current)) items.unshift({ id: current, label: current });
  return items;
}

function renderBriefStep() {
  const ps = $("#provSelect");
  ps.innerHTML = Object.entries(PROVIDERS)
    .map(([id, p]) => `<option value="${id}">${p.label}${settings.keys[id] ? "" : " — no key"}</option>`)
    .join("");
  ps.value = settings.provider;
  const ms = $("#modelSelect");
  const items = modelOptions(settings.provider);
  ms.innerHTML = items.length
    ? items.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.label)}</option>`).join("")
    : `<option value="">Add key in Settings to load models</option>`;
  ms.value = settings.models[settings.provider] || items[0]?.id || "";

  const ready = [
    [!!state.scraped, "Video captured", "Capture a video in step 1"],
    [!!currentProfile(), "Character set", "Create a character in step 2"],
    [!!settings.keys[settings.provider], "API key", "Add an API key in Settings"],
    [!!ms.value, "Model", "Pick a model"],
    [state.frames.length > 0, `${state.frames.length} frame(s)`, "No frames (optional)"],
  ];
  $("#briefReadiness").innerHTML = ready
    .map(([ok, yes, no], i) => `<span class="pill ${ok ? "ok" : i === 4 ? "" : "warm"}">${ok ? "✓ " + yes : "• " + no}</span>`)
    .join("");
  const blocked = ready.slice(0, 4).some(([ok]) => !ok);
  $("#btnGenerate").disabled = blocked || !!abort;
  $("#btnGenerate").textContent = state.brief ? "↻ Regenerate brief" : "✨ Generate brief";

  const b = state.brief;
  $("#briefSummary").classList.toggle("hidden", !b);
  if (b) {
    $("#bsFormat").textContent = b.formatName || (b.parsed ? "Brief" : "Brief (unstructured reply)");
    $("#bsScore").textContent = b.replicabilityScore != null ? `Replicability ${b.replicabilityScore}/10` : "";
    $("#bsScore").className = "pill " + (b.replicabilityScore >= 7 ? "ok" : b.replicabilityScore >= 5 ? "warm" : "hot");
    $("#bsWhy").textContent = b.whyItWorks || "";
    $("#bsReason").textContent = b.replicabilityReason || "";
    $("#bsScene").textContent = b.sceneDescription || "";
    $("#bsTwist").textContent = b.originalityTwist || "—";
    $("#bsAssumptions").textContent = b.assumptions ? "Assumed: " + b.assumptions : "";
  }
}

function checklistHTML(prefix, items) {
  return items
    .map(([key, html]) => {
      const id = prefix + "_" + key;
      return `<li><label class="check"><input type="checkbox" data-check="${id}" ${state.checks[id] ? "checked" : ""}><span>${html}</span></label></li>`;
    })
    .join("");
}

function renderProduce() {
  const b = state.brief;
  $("#produceEmpty").classList.toggle("hidden", !!b);
  $("#produceBody").classList.toggle("hidden", !b);
  if (!b) return;
  $("#imagePrompt").value = b.imagePrompt || "";
  $("#videoPrompt").value = b.videoPrompt || "";
  $("#shotList").innerHTML = (b.shotList || [])
    .map(
      (s) => `<li><span class="t">${escapeHtml(s.seconds || "")}</span>${escapeHtml(s.action || "")}
      ${s.camera ? `<span class="cam">🎥 ${escapeHtml(s.camera)}</span>` : ""}
      ${s.onScreenText ? `<span class="ost">🅃 "${escapeHtml(s.onScreenText)}"</span>` : ""}</li>`
    )
    .join("") || `<li class="muted">No shot list returned.</li>`;
  $("#audio").textContent = b.audioSuggestion || "—";
  const img = escapeHtml(settings.prefs.imageTool);
  const vid = escapeHtml(settings.prefs.videoTool);
  $("#produceChecklist").innerHTML = checklistHTML("p", [
    ["img", `Open <b>${img}</b>, upload your character reference image, paste the <b>image prompt</b>, set ratio <b>9:16</b>.`],
    ["pick", "Generate 3–4 variations and keep the one where the face matches your character best."],
    ["anim", `Open <b>${vid}</b>, upload that image and paste the <b>motion prompt</b>. Keep clips 3–6 s.`],
    ["shots", "Repeat for each shot in the shot list (reuse the same reference image every time)."],
    ["edit", "Assemble in your editor: hook text on screen for the first 2 s, captions on, sound per the audio note."],
    ["export", "Export vertical 1080×1920, under 60 s. Watch it once on your phone before posting."],
  ]);
}

function renderPublish() {
  const b = state.brief;
  $("#publishEmpty").classList.toggle("hidden", !!b);
  $("#publishBody").classList.toggle("hidden", !b);
  if (!b) return;
  const hooks = b.hooks?.length ? b.hooks : ["(no hooks returned — press New options)"];
  $("#hooks").innerHTML = hooks
    .map(
      (h, i) => `<label class="hook"><input type="radio" name="hook" value="${i}" ${i === (state.chosenHook || 0) ? "checked" : ""}>
      <span>${escapeHtml(h)}</span><button class="btn sm ghost" data-copy-hook="${i}" title="Copy hook">⧉</button></label>`
    )
    .join("");
  $("#caption").value = b.caption || "";
  $("#hashtags").value = (b.hashtags || []).map((h) => "#" + h).join(" ");
  $("#bait").textContent = b.engagementBait || "—";
  const plat = targetPlatform();
  $("#publishChecklist").innerHTML = checklistHTML("u", [
    ["post", `Upload to <b>${plat === "instagram" ? "Instagram Reels" : plat === "youtube shorts" ? "YouTube Shorts" : "TikTok"}</b> with your chosen hook as the opening text and the caption above.`],
    ["label", "Turn on the platform's <b>AI-generated content</b> label (TikTok: “AI-generated content” toggle; Instagram: “AI info”). Required for realistic AI people and protects your account."],
    ["pin", "Post the debate starter as the first comment and pin it."],
    ["reply", "Reply to as many comments as you can in the first hour — it boosts distribution."],
    ["cross", "Cross-post the same video to the other platforms (TikTok, Reels, Shorts) within 24 h."],
    ["track", "Come back in 48 h and note what worked; reuse winning formats with the same character."],
  ]);
}

function targetPlatform() {
  const t = state.targetPlatform;
  return t && t !== "auto" ? t : state.scraped?.platform || "tiktok";
}

// ------------------------------------------------------------------ generate
async function doGenerate() {
  const provider = $("#provSelect").value;
  const model = $("#modelSelect").value;
  const apiKey = settings.keys[provider];
  const profile = currentProfile();
  if (!apiKey) return toast("Add an API key in Settings first");
  if (!state.scraped || !profile) return;

  abort = new AbortController();
  $("#btnGenerate").disabled = true;
  $("#btnCancel").classList.remove("hidden");
  const status = $("#genStatus");
  const started = Date.now();
  status.innerHTML = `<span class="spinner"></span> Writing your brief with ${escapeHtml(model)}…`;
  const tick = setInterval(() => {
    status.innerHTML = `<span class="spinner"></span> Writing your brief with ${escapeHtml(model)}… ${Math.round((Date.now() - started) / 1000)}s`;
  }, 1000);

  try {
    const brief = await generateBrief({
      scraped: state.scraped,
      profile,
      provider,
      apiKey,
      model,
      images: state.frames,
      notes: state.notes,
      prefs: settings.prefs,
      extraDirection: state.extraDirection,
      targetPlatform: targetPlatform(),
      signal: abort.signal,
    });
    state.brief = brief;
    state.chosenHook = 0;
    state.id = state.id || generateId();
    await saveToHistory(provider, model);
    status.textContent = `Done in ${Math.round((Date.now() - started) / 1000)}s · saved to History`;
    if (!brief.parsed) toast("The AI replied in an unexpected format — showing raw text");
    renderAll();
  } catch (e) {
    if (e.name === "AbortError") status.textContent = "Cancelled.";
    else status.innerHTML = `<div class="notice error">${escapeHtml(e.message || String(e))}</div>`;
  } finally {
    clearInterval(tick);
    abort = null;
    $("#btnCancel").classList.add("hidden");
    renderBriefStep();
    persist();
  }
}

async function saveToHistory(provider, model) {
  const s = state.scraped || {};
  const p = currentProfile();
  await appendToHistory({
    id: state.id,
    platform: s.platform,
    videoUrl: s.videoUrl,
    authorHandle: s.authorHandle,
    views: s.views,
    likes: s.likes,
    postDate: s.postDate,
    profileName: p?.name,
    provider: provider || settings.provider,
    model: model || settings.models[settings.provider],
    scraped: s,
    notes: state.notes,
    brief: state.brief,
  });
}

// keep edits made in Produce/Publish
function syncEdits() {
  if (!state.brief) return;
  state.brief.imagePrompt = $("#imagePrompt").value;
  state.brief.videoPrompt = $("#videoPrompt").value;
  state.brief.caption = $("#caption").value;
  state.brief.hashtags = $("#hashtags").value.split(/\s+/).map((h) => h.replace(/^#/, "")).filter(Boolean);
  persist();
  clearTimeout(syncEdits._h);
  syncEdits._h = setTimeout(() => saveToHistory(), 800);
}

function captionWithTags() {
  const tags = $("#hashtags").value.trim();
  return [$("#caption").value.trim(), tags].filter(Boolean).join("\n\n");
}

function fullBriefText() {
  syncEdits();
  const b = { ...state.brief };
  if (b.hooks?.length && state.chosenHook) {
    const h = [...b.hooks];
    const [chosen] = h.splice(state.chosenHook, 1);
    b.hooks = [chosen + "  ← chosen", ...h];
  }
  return briefToPlainText(b, state.scraped, currentProfile());
}

function newBrief() {
  state = { id: null, step: 0, scraped: null, frames: [], notes: "", targetPlatform: "auto", extraDirection: "", brief: null, chosenHook: 0, checks: {} };
  persist();
  scan({ autoFrame: true }).then(() => {
    renderAll();
    goto(0);
  });
}

// ------------------------------------------------------------------ history
async function showHistory(show = true) {
  $("#historyView").classList.toggle("hidden", !show);
  if (show) renderHistory();
}

async function renderHistory() {
  const q = $("#historySearch").value.trim().toLowerCase();
  const items = (await getHistory()).filter((h) =>
    !q || [h.authorHandle, h.brief?.formatName, h.brief?.caption, h.profileName].join(" ").toLowerCase().includes(q)
  );
  $("#historyList").innerHTML = items.length
    ? items
        .map(
          (h) => `<div class="h-item">
        <div class="h-top"><span>${h.platform === "instagram" ? "Instagram" : "TikTok"} · @${escapeHtml(h.authorHandle || "?")}</span><span>${new Date(h.timestamp).toLocaleString()}</span></div>
        <h3>${escapeHtml(h.brief?.formatName || "Brief")}</h3>
        <div class="small muted">${formatNumber(h.views)} views · ${formatNumber(h.likes)} likes · ${escapeHtml(h.profileName || "")}${h.brief?.replicabilityScore != null ? ` · ${h.brief.replicabilityScore}/10` : ""}</div>
        <div class="h-actions">
          <button class="btn sm primary" data-h-open="${h.id}">Open</button>
          <button class="btn sm" data-h-copy="${h.id}">Copy</button>
          <a class="btn sm" href="${escapeHtml(h.videoUrl || "#")}" target="_blank">Source ↗</a>
          <button class="btn sm danger" data-h-del="${h.id}" title="Delete">✕</button>
        </div></div>`
        )
        .join("")
    : `<div class="empty"><div class="empty-icon">🗂</div><p class="muted">No briefs yet.</p></div>`;
}

// ------------------------------------------------------------------ events
function bindUI() {
  $("#steps").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-step]");
    if (b) goto(Number(b.dataset.step));
  });
  $("#btnBack").onclick = () => goto(state.step - 1);
  $("#btnNext").onclick = () => {
    if (state.step === 4) return newBrief();
    if (state.step === 2 && !state.brief) return doGenerate();
    goto(state.step + 1);
  };

  $("#btnSettings").onclick = () => chrome.runtime.openOptionsPage();
  $("#btnManageChars").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("options/options.html#characters") });
  $("#btnHistory").onclick = () => showHistory(true);
  $("#btnHistoryBack").onclick = () => showHistory(false);
  $("#historySearch").oninput = renderHistory;
  $("#btnHistoryClear").onclick = async () => {
    if (!confirm("Delete all saved briefs? This can't be undone.")) return;
    await clearHistory();
    renderHistory();
  };
  $("#btnNew").onclick = () => {
    if (state.brief && !confirm("Start a new brief? The current one stays in History.")) return;
    newBrief();
  };
  $("#btnDensity").onclick = async () => {
    settings = await saveSettings({ prefs: { compact: !settings.prefs.compact } });
    applyTheme();
  };

  $("#historyList").addEventListener("click", async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    const items = await getHistory();
    if (t.dataset.hOpen) {
      const h = items.find((x) => x.id === t.dataset.hOpen);
      if (!h) return;
      state = { ...state, id: h.id, scraped: h.scraped || { platform: h.platform, videoUrl: h.videoUrl, authorHandle: h.authorHandle, views: h.views, likes: h.likes, postDate: h.postDate }, frames: [], notes: h.notes || "", brief: h.brief, chosenHook: 0, checks: {} };
      persist();
      renderAll();
      showHistory(false);
      goto(3);
    } else if (t.dataset.hCopy) {
      const h = items.find((x) => x.id === t.dataset.hCopy);
      await copyToClipboard(briefToPlainText(h.brief, h.scraped || h, { name: h.profileName }));
      toast("Brief copied");
    } else if (t.dataset.hDel) {
      await deleteHistoryEntry(t.dataset.hDel);
      renderHistory();
    }
  });

  // capture
  $("#btnScan").onclick = () => scan();
  $("#btnFrame").onclick = () => grabFrame();
  $("#frames").addEventListener("click", (e) => {
    const i = e.target.dataset?.rm;
    if (i == null) return;
    state.frames.splice(Number(i), 1);
    persist();
    renderFrames();
  });
  $("#notes").oninput = (e) => { state.notes = e.target.value; persist(); };
  $("#btnRescanBanner").onclick = () => scan({ autoFrame: true });
  $("#btnDismissBanner").onclick = () => $("#pageChanged").classList.add("hidden");

  // character
  $("#charSelect").onchange = async (e) => {
    await setActiveProfile(e.target.value);
    settings = await getSettings();
    renderCharacter();
    markDone();
  };
  $("#btnQuickSave").onclick = async () => {
    const name = $("#qcName").value.trim();
    const appearance = $("#qcAppearance").value.trim();
    if (!name || !appearance) return toast("Name and appearance are required");
    const p = await saveCharacterProfile({
      name, appearance,
      personality: $("#qcPersonality").value.trim(),
      recurringSet: $("#qcSet").value.trim(),
    });
    await setActiveProfile(p.id);
    settings = await getSettings();
    renderAll();
    toast("Character saved");
  };
  $("#targetPlatform").onchange = (e) => { state.targetPlatform = e.target.value; persist(); };
  $("#extraDirection").oninput = (e) => { state.extraDirection = e.target.value; persist(); };

  // brief
  $("#provSelect").onchange = async (e) => {
    const provider = e.target.value;
    settings = await saveSettings({ provider });
    // Auto-load model list the first time a provider with a key is chosen.
    if (settings.keys[provider] && !settings.modelLists?.[provider]?.items?.length) {
      try {
        const items = await listModels(provider, settings.keys[provider]);
        const patch = { modelLists: { [provider]: { items, fetchedAt: Date.now() } } };
        if (!settings.models[provider] && items[0]) patch.models = { [provider]: items[0].id };
        settings = await saveSettings(patch);
      } catch (err) {
        toast(err.message);
      }
    }
    renderBriefStep();
  };
  $("#modelSelect").onchange = async (e) => {
    settings = await saveSettings({ models: { [$("#provSelect").value]: e.target.value } });
    renderBriefStep();
  };
  $("#btnGenerate").onclick = doGenerate;
  $("#btnCancel").onclick = () => abort?.abort();

  // produce / publish edits
  ["#imagePrompt", "#videoPrompt", "#caption", "#hashtags"].forEach((s) => $(s).addEventListener("input", syncEdits));
  document.addEventListener("click", async (e) => {
    const c = e.target.closest("[data-copy]");
    if (c) {
      await copyToClipboard($("#" + c.dataset.copy).value);
      return toast("Copied");
    }
    const ct = e.target.closest("[data-copy-text]");
    if (ct) {
      await copyToClipboard($("#" + ct.dataset.copyText).textContent);
      return toast("Copied");
    }
    const ch = e.target.closest("[data-copy-hook]");
    if (ch) {
      e.preventDefault();
      await copyToClipboard(state.brief.hooks[Number(ch.dataset.copyHook)]);
      return toast("Hook copied");
    }
  });
  document.addEventListener("change", (e) => {
    if (e.target.dataset?.check) {
      state.checks[e.target.dataset.check] = e.target.checked;
      persist();
      markDone();
    }
    if (e.target.name === "hook") {
      state.chosenHook = Number(e.target.value);
      persist();
    }
  });
  $("#btnCopyShots").onclick = async () => {
    const t = (state.brief?.shotList || [])
      .map((s, i) => `${i + 1}. [${s.seconds}] ${s.action}${s.camera ? " — " + s.camera : ""}${s.onScreenText ? ` — text: "${s.onScreenText}"` : ""}`)
      .join("\n");
    await copyToClipboard(t);
    toast("Shot list copied");
  };
  $("#btnCopyCaption").onclick = async () => {
    await copyToClipboard(captionWithTags());
    toast("Caption copied");
  };
  $("#btnCopyAll").onclick = async () => {
    await copyToClipboard(fullBriefText());
    toast("Full brief copied");
  };
  $("#btnExport").onclick = () => {
    const name = `scenepull-${slug(state.scraped?.authorHandle)}-${slug(state.brief?.formatName)}.txt`;
    downloadTextFile(fullBriefText(), name);
  };
  $("#btnRegenCopy").onclick = async () => {
    const provider = settings.provider;
    const btn = $("#btnRegenCopy");
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>`;
    try {
      const r = await regenerateCopy({
        brief: state.brief,
        profile: currentProfile(),
        provider,
        apiKey: settings.keys[provider],
        model: settings.models[provider],
        prefs: settings.prefs,
        platform: targetPlatform(),
      });
      if (r.hooks?.length) state.brief.hooks = r.hooks;
      if (r.caption) state.brief.caption = r.caption;
      if (r.hashtags?.length) state.brief.hashtags = r.hashtags;
      state.chosenHook = 0;
      await saveToHistory();
      renderPublish();
      persist();
    } catch (e) {
      toast(e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "↻ New options";
    }
  };

  // tab / page change awareness
  chrome.tabs.onActivated.addListener(onTabChange);
  chrome.tabs.onUpdated.addListener((id, info) => {
    if (id === tab?.id && info.url) onTabChange();
  });
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg?.type === "SP_PAGE_CHANGED" && sender.tab?.id === tab?.id) onTabChange();
  });
  chrome.storage.onChanged.addListener(async (changes) => {
    if (changes.settings) {
      settings = await getSettings();
      applyTheme();
      renderCharacter();
      renderBriefStep();
      markDone();
    }
  });
}

let changeTimer = null;
function onTabChange() {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(async () => {
    await refreshTab();
    if (!isSupported(tab?.url)) return renderCapture();
    if (!state.scraped) return scan({ autoFrame: true });
    // Don't wipe work silently — ask.
    const res = await sendToTab({ type: "SP_SCRAPE" }).catch(() => null);
    const url = res?.data?.videoUrl;
    if (url && url !== state.scraped.videoUrl) $("#pageChanged").classList.remove("hidden");
  }, 700);
}
