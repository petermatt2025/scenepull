// chrome.storage.local wrapper. Everything lives on this device only.
import { generateId } from "./utils.js";

export const DEFAULT_SETTINGS = {
  provider: "anthropic", // anthropic | openai | gemini | openrouter
  keys: { anthropic: "", openai: "", gemini: "", openrouter: "" },
  models: {
    anthropic: "claude-sonnet-5-5",
    openai: "",
    gemini: "",
    openrouter: "openrouter/auto",
  },
  modelLists: {}, // cached { provider: [{id,label}], fetchedAt }
  prefs: {
    showFloatingButton: true,
    trendViewThreshold: 500000,
    trendVelocityThreshold: 20000, // views per hour
    captureFrame: true,
    hookCount: 3,
    language: "English",
    imageTool: "your image tool",
    videoTool: "your image-to-video tool",
    theme: "auto", // auto | light | dark
    compact: false,
  },
  profiles: [],
  activeProfileId: null,
};

const HISTORY_CAP = 50;

function merge(base, over) {
  const out = { ...base };
  for (const k of Object.keys(over || {})) {
    const v = over[k];
    out[k] = v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" && !Array.isArray(base[k])
      ? merge(base[k], v)
      : v;
  }
  return out;
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return merge(DEFAULT_SETTINGS, settings || {});
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = merge(current, patch);
  await chrome.storage.local.set({ settings: next });
  return next;
}

// ---- character profiles ----
export async function getCharacterProfiles() {
  return (await getSettings()).profiles;
}

export async function saveCharacterProfile(profile) {
  const s = await getSettings();
  const p = { ...profile, id: profile.id || generateId() };
  const i = s.profiles.findIndex((x) => x.id === p.id);
  if (i >= 0) s.profiles[i] = p;
  else s.profiles.push(p);
  if (!s.activeProfileId) s.activeProfileId = p.id;
  await chrome.storage.local.set({ settings: s });
  return p;
}

export async function deleteCharacterProfile(id) {
  const s = await getSettings();
  s.profiles = s.profiles.filter((p) => p.id !== id);
  if (s.activeProfileId === id) s.activeProfileId = s.profiles[0]?.id || null;
  await chrome.storage.local.set({ settings: s });
}

export async function getActiveProfile() {
  const s = await getSettings();
  return s.profiles.find((p) => p.id === s.activeProfileId) || s.profiles[0] || null;
}

export async function setActiveProfile(id) {
  await saveSettings({ activeProfileId: id });
}

// ---- keys / models ----
export async function getApiKey(provider) {
  const s = await getSettings();
  return s.keys[provider || s.provider] || null;
}

export async function getModel(provider) {
  const s = await getSettings();
  return s.models[provider || s.provider] || "";
}

// ---- history ----
export async function getHistory() {
  const { history } = await chrome.storage.local.get("history");
  return history || [];
}

export async function appendToHistory(entry) {
  const history = await getHistory();
  const e = { id: entry.id || generateId(), timestamp: Date.now(), ...entry };
  const filtered = history.filter((h) => h.id !== e.id);
  filtered.unshift(e);
  await chrome.storage.local.set({ history: filtered.slice(0, HISTORY_CAP) });
  return e;
}

export async function deleteHistoryEntry(id) {
  const history = await getHistory();
  await chrome.storage.local.set({ history: history.filter((h) => h.id !== id) });
}

export async function clearHistory() {
  await chrome.storage.local.set({ history: [] });
}

// ---- import / export ----
export async function exportAll({ includeKeys = false, includeHistory = true } = {}) {
  const settings = await getSettings();
  const copy = JSON.parse(JSON.stringify(settings));
  delete copy.modelLists;
  if (!includeKeys) copy.keys = { anthropic: "", openai: "", gemini: "", openrouter: "" };
  return {
    app: "ScenePull",
    format: 1,
    exportedAt: new Date().toISOString(),
    includesKeys: includeKeys,
    settings: copy,
    history: includeHistory ? await getHistory() : [],
  };
}

export async function importAll(payload, { mode = "merge" } = {}) {
  if (!payload || payload.app !== "ScenePull" || !payload.settings) {
    throw new Error("This file is not a ScenePull export.");
  }
  const current = await getSettings();
  const incoming = payload.settings;

  let next;
  if (mode === "replace") {
    next = merge(DEFAULT_SETTINGS, incoming);
  } else {
    next = merge(current, { ...incoming, profiles: undefined, keys: undefined });
    // keep existing keys unless the file actually carries one
    next.keys = { ...current.keys };
    for (const [k, v] of Object.entries(incoming.keys || {})) if (v) next.keys[k] = v;
    // merge profiles by id
    const byId = new Map(current.profiles.map((p) => [p.id, p]));
    for (const p of incoming.profiles || []) byId.set(p.id, p);
    next.profiles = [...byId.values()];
  }
  if (!next.profiles.find((p) => p.id === next.activeProfileId)) {
    next.activeProfileId = next.profiles[0]?.id || null;
  }
  await chrome.storage.local.set({ settings: next });

  if (Array.isArray(payload.history) && payload.history.length) {
    const existing = mode === "replace" ? [] : await getHistory();
    const byId = new Map(existing.map((h) => [h.id, h]));
    for (const h of payload.history) byId.set(h.id, h);
    const merged = [...byId.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, HISTORY_CAP);
    await chrome.storage.local.set({ history: merged });
  }
  return next;
}

export async function resetAll() {
  await chrome.storage.local.clear();
}
