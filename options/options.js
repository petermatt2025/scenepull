import {
  getSettings, saveSettings, saveCharacterProfile, deleteCharacterProfile,
  setActiveProfile, exportAll, importAll, resetAll,
} from "../lib/storage.js";
import { PROVIDERS, testKey } from "../lib/providers.js";
import { escapeHtml, downloadTextFile } from "../lib/utils.js";

const $ = (s) => document.querySelector(s);
let settings;
let editingId = null;

init();

async function init() {
  settings = await getSettings();
  $("#version").textContent = "v" + chrome.runtime.getManifest().version;
  applyTheme();
  renderProviders();
  renderChars();
  renderPrefs();
  bind();
  if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
}

function applyTheme() {
  const t = settings.prefs.theme;
  if (t === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), 2000);
}

// ---------------------------------------------------------------- providers
function modelsFor(id) {
  const cached = settings.modelLists?.[id]?.items;
  const list = cached?.length ? cached : PROVIDERS[id].fallbackModels;
  const cur = settings.models[id];
  const items = [...list];
  if (cur && !items.find((m) => m.id === cur)) items.unshift({ id: cur, label: cur });
  return items;
}

function renderProviders() {
  $("#activeProvider").innerHTML = Object.entries(PROVIDERS)
    .map(([id, p]) => `<option value="${id}">${p.label}${settings.keys[id] ? " ✓" : ""}</option>`)
    .join("");
  $("#activeProvider").value = settings.provider;

  $("#providerCards").innerHTML = Object.entries(PROVIDERS)
    .map(([id, p]) => {
      const items = modelsFor(id);
      const fetched = settings.modelLists?.[id]?.fetchedAt;
      return `<div class="card prov-card ${settings.provider === id ? "active" : ""}" data-prov="${id}">
        <div class="card-head">
          <h3>${p.label} ${settings.keys[id] ? '<span class="pill ok">key saved</span>' : ""} ${settings.provider === id ? '<span class="pill">active</span>' : ""}</h3>
          <a class="small" href="${p.keyUrl}" target="_blank">Get a key ↗</a>
        </div>
        <label class="field">API key <span class="muted small">(${p.keyHint})</span>
          <div class="key-row">
            <input type="password" data-key="${id}" value="${escapeHtml(settings.keys[id] || "")}" placeholder="Paste your ${p.label} key" autocomplete="off" spellcheck="false" />
            <button class="btn sm" data-show="${id}" title="Show / hide key">👁</button>
            <button class="btn sm primary" data-test="${id}">Test &amp; load models</button>
          </div>
        </label>
        <label class="field" style="margin-top:10px"><span class="row">Model
          <span class="tip" tabindex="0" data-tip="'Test & load models' pulls the newest models your key can use, straight from ${p.label}. Newest are listed first.">?</span></span>
          <select data-model="${id}">
            ${items.length ? items.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.label)}${m.vision === false ? " (text only)" : ""}</option>`).join("") : '<option value="">Test your key to load models</option>'}
          </select>
        </label>
        <div class="meta"><span class="muted" data-status="${id}">${fetched ? "Models updated " + new Date(fetched).toLocaleDateString() : ""}</span>
          ${settings.keys[id] ? `<button class="btn sm ghost danger" data-clear="${id}">Remove key</button>` : ""}</div>
      </div>`;
    })
    .join("");
  for (const id of Object.keys(PROVIDERS)) {
    const sel = document.querySelector(`[data-model="${id}"]`);
    if (settings.models[id]) sel.value = settings.models[id];
  }
}

async function testProvider(id) {
  const input = document.querySelector(`[data-key="${id}"]`);
  const status = document.querySelector(`[data-status="${id}"]`);
  const key = input.value.trim();
  if (!key) return toast("Paste a key first");
  status.innerHTML = `<span class="spinner"></span> Checking…`;
  try {
    const items = await testKey(id, key);
    const patch = {
      keys: { [id]: key },
      modelLists: { [id]: { items, fetchedAt: Date.now() } },
    };
    const current = settings.models[id];
    if (!current || !items.find((m) => m.id === current)) {
      const preferred = items.find((m) => m.id === PROVIDERS[id].defaultModel) || items[0];
      if (preferred) patch.models = { [id]: preferred.id };
    }
    // First working key becomes the active provider.
    if (!settings.keys[settings.provider] || settings.provider === id) patch.provider = id;
    settings = await saveSettings(patch);
    renderProviders();
    toast(`Key works — ${items.length} models loaded`);
  } catch (e) {
    status.innerHTML = `<span style="color:var(--sp-danger)">${escapeHtml(e.message)}</span>`;
  }
}

// ---------------------------------------------------------------- characters
function renderChars() {
  const list = $("#charList");
  if (!settings.profiles.length) {
    list.innerHTML = `<div class="card muted">No characters yet. Click <b>New character</b> to create one.</div>`;
    return;
  }
  list.innerHTML = settings.profiles
    .map((p) => {
      const active = p.id === settings.activeProfileId;
      return `<div class="char-item ${active ? "active" : ""}">
        <h3>${escapeHtml(p.name)} ${active ? '<span class="pill ok">active</span>' : ""}</h3>
        <p><b>Look:</b> ${escapeHtml(p.appearance || "—")}</p>
        ${p.personality ? `<p><b>Voice:</b> ${escapeHtml(p.personality)}</p>` : ""}
        ${p.recurringSet ? `<p><b>Set:</b> ${escapeHtml(p.recurringSet)}</p>` : ""}
        <div class="row wrap">
          ${active ? "" : `<button class="btn sm primary" data-activate="${p.id}">Use this one</button>`}
          <button class="btn sm" data-edit="${p.id}">Edit</button>
          <button class="btn sm" data-dup="${p.id}">Duplicate</button>
          <button class="btn sm danger" data-del="${p.id}">Delete</button>
        </div></div>`;
    })
    .join("");
}

function openCharForm(p) {
  editingId = p?.id || null;
  $("#charFormTitle").textContent = p?.id ? "Edit character" : "New character";
  $("#cfName").value = p?.name || "";
  $("#cfAppearance").value = p?.appearance || "";
  $("#cfPersonality").value = p?.personality || "";
  $("#cfSet").value = p?.recurringSet || "";
  $("#cfStyle").value = p?.style || "";
  $("#cfNiche").value = p?.niche || "";
  $("#cfAvoid").value = p?.avoid || "";
  $("#charForm").classList.remove("hidden");
  $("#cfName").focus();
  $("#charForm").scrollIntoView({ behavior: "smooth", block: "center" });
}

// ---------------------------------------------------------------- prefs
function renderPrefs() {
  const p = settings.prefs;
  $("#pfFab").checked = !!p.showFloatingButton;
  $("#pfFrame").checked = !!p.captureFrame;
  $("#pfViews").value = p.trendViewThreshold;
  $("#pfVelocity").value = p.trendVelocityThreshold;
  $("#pfHooks").value = String(p.hookCount);
  $("#pfLang").value = p.language;
  $("#pfImgTool").value = p.imageTool;
  $("#pfVidTool").value = p.videoTool;
  $("#pfTheme").value = p.theme;
}

// ---------------------------------------------------------------- events
function bind() {
  // nav highlight
  const links = [...document.querySelectorAll("#nav a")];
  const obs = new IntersectionObserver(
    (entries) => entries.forEach((e) => {
      if (e.isIntersecting) links.forEach((a) => a.classList.toggle("active", a.getAttribute("href") === "#" + e.target.id));
    }),
    { rootMargin: "-40% 0px -55% 0px" }
  );
  document.querySelectorAll(".panel").forEach((s) => obs.observe(s));

  $("#activeProvider").onchange = async (e) => {
    settings = await saveSettings({ provider: e.target.value });
    renderProviders();
    toast("Active provider updated");
  };

  $("#providerCards").addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.test) testProvider(b.dataset.test);
    if (b.dataset.show) {
      const i = document.querySelector(`[data-key="${b.dataset.show}"]`);
      i.type = i.type === "password" ? "text" : "password";
    }
    if (b.dataset.clear) {
      if (!confirm("Remove this key from ScenePull?")) return;
      settings = await saveSettings({ keys: { [b.dataset.clear]: "" } });
      renderProviders();
    }
  });
  $("#providerCards").addEventListener("change", async (e) => {
    if (e.target.dataset.model) {
      settings = await saveSettings({ models: { [e.target.dataset.model]: e.target.value } });
      toast("Model saved");
    }
    if (e.target.dataset.key) {
      settings = await saveSettings({ keys: { [e.target.dataset.key]: e.target.value.trim() } });
    }
  });

  $("#btnAddChar").onclick = () => openCharForm(null);
  $("#btnCancelChar").onclick = () => $("#charForm").classList.add("hidden");
  $("#btnSaveChar").onclick = async () => {
    const name = $("#cfName").value.trim();
    const appearance = $("#cfAppearance").value.trim();
    if (!name || !appearance) return toast("Name and fixed appearance are required");
    const p = await saveCharacterProfile({
      id: editingId || undefined,
      name, appearance,
      personality: $("#cfPersonality").value.trim(),
      recurringSet: $("#cfSet").value.trim(),
      style: $("#cfStyle").value.trim(),
      niche: $("#cfNiche").value.trim(),
      avoid: $("#cfAvoid").value.trim(),
    });
    settings = await getSettings();
    if (!settings.activeProfileId) await setActiveProfile(p.id);
    settings = await getSettings();
    $("#charForm").classList.add("hidden");
    renderChars();
    toast("Character saved");
  };
  $("#charList").addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const find = (id) => settings.profiles.find((p) => p.id === id);
    if (b.dataset.activate) await setActiveProfile(b.dataset.activate);
    if (b.dataset.edit) return openCharForm(find(b.dataset.edit));
    if (b.dataset.dup) {
      const src = find(b.dataset.dup);
      await saveCharacterProfile({ ...src, id: undefined, name: src.name + " (copy)" });
    }
    if (b.dataset.del) {
      if (!confirm(`Delete "${find(b.dataset.del)?.name}"?`)) return;
      await deleteCharacterProfile(b.dataset.del);
    }
    settings = await getSettings();
    renderChars();
  });

  $("#btnSavePrefs").onclick = async () => {
    settings = await saveSettings({
      prefs: {
        showFloatingButton: $("#pfFab").checked,
        captureFrame: $("#pfFrame").checked,
        trendViewThreshold: Math.max(1000, Number($("#pfViews").value) || 500000),
        trendVelocityThreshold: Math.max(100, Number($("#pfVelocity").value) || 20000),
        hookCount: Number($("#pfHooks").value) || 3,
        language: $("#pfLang").value.trim() || "English",
        imageTool: $("#pfImgTool").value.trim() || "your image tool",
        videoTool: $("#pfVidTool").value.trim() || "your image-to-video tool",
        theme: $("#pfTheme").value,
      },
    });
    applyTheme();
    toast("Preferences saved");
  };

  // export / import
  $("#btnExport").onclick = async () => {
    const includeKeys = $("#exKeys").checked;
    if (includeKeys && !confirm("The file will contain your API keys in plain text. Keep it private. Continue?")) return;
    const data = await exportAll({ includeKeys, includeHistory: $("#exHistory").checked });
    const stamp = new Date().toISOString().slice(0, 10);
    downloadTextFile(JSON.stringify(data, null, 2), `scenepull-settings-${stamp}.json`, "application/json");
    toast("Export downloaded");
  };
  $("#btnImport").onclick = () => $("#importFile").click();
  $("#importFile").onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const status = $("#importStatus");
    try {
      const payload = JSON.parse(await file.text());
      const mode = document.querySelector("input[name=imMode]:checked").value;
      if (mode === "replace" && !confirm("Replace ALL current ScenePull data with this file?")) return;
      settings = await importAll(payload, { mode });
      renderProviders();
      renderChars();
      renderPrefs();
      applyTheme();
      status.innerHTML = `<span class="pill ok">Imported ${settings.profiles.length} character(s)${payload.includesKeys ? " + API keys" : ""}</span>`;
    } catch (err) {
      status.innerHTML = `<span style="color:var(--sp-danger)">${escapeHtml(err.message)}</span>`;
    } finally {
      e.target.value = "";
    }
  };
  $("#btnReset").onclick = async () => {
    if (!confirm("Delete ALL ScenePull data from this browser?")) return;
    await resetAll();
    settings = await getSettings();
    renderProviders();
    renderChars();
    renderPrefs();
    toast("ScenePull reset");
  };
}
