// Small helpers shared by the side panel and settings page.

export function generateId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

export function formatNumber(n) {
  if (n == null || n === "") return "—";
  const num = typeof n === "number" ? n : Number(String(n).replace(/,/g, ""));
  if (!Number.isFinite(num)) return String(n);
  return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(num);
}

export function timeAgo(iso) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "—";
  const h = ms / 36e5;
  if (h < 1) return Math.max(1, Math.round(ms / 6e4)) + " min ago";
  if (h < 48) return Math.round(h) + " h ago";
  const d = h / 24;
  if (d < 60) return Math.round(d) + " days ago";
  return Math.round(d / 30) + " months ago";
}

export function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// Rule-based trend signal (no AI): views per hour since posting + engagement rate.
export function computeTrend(data, prefs = {}) {
  const viewsThreshold = prefs.trendViewThreshold ?? 500000;
  const velThreshold = prefs.trendVelocityThreshold ?? 20000;
  const ageHrs = data?.postDate ? Math.max(1, (Date.now() - new Date(data.postDate)) / 36e5) : null;
  const views = data?.views ?? null;
  const velocity = views && ageHrs ? views / ageHrs : null;
  const engagement =
    views && (data.likes || data.comments || data.shares)
      ? ((data.likes || 0) + (data.comments || 0) * 2 + (data.shares || 0) * 3 + (data.saves || 0) * 2) / views
      : null;

  let label = "Unknown";
  let level = "unknown";
  if (velocity != null) {
    if (velocity >= velThreshold) { label = "Hot"; level = "hot"; }
    else if (velocity >= velThreshold / 4) { label = "Warm"; level = "warm"; }
    else { label = "Cooling"; level = "cold"; }
  } else if (views != null) {
    if (views >= viewsThreshold) { label = "Hot"; level = "hot"; }
    else if (views >= viewsThreshold / 5) { label = "Warm"; level = "warm"; }
    else { label = "Cooling"; level = "cold"; }
  } else if (data?.likes != null) {
    // Instagram often hides plays: fall back to likes.
    if (data.likes >= viewsThreshold / 20) { label = "Hot"; level = "hot"; }
    else if (data.likes >= viewsThreshold / 100) { label = "Warm"; level = "warm"; }
    else { label = "Cooling"; level = "cold"; }
  }
  return { label, level, ageHrs, velocity, engagement };
}

export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

export function downloadTextFile(text, filename, mime = "text/plain") {
  const blob = new Blob([text], { type: mime + ";charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function slug(s) {
  return String(s || "brief").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "brief";
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function briefToPlainText(brief, scraped, profile) {
  const b = brief || {};
  const s = scraped || {};
  const list = (arr) => (arr || []).map((x, i) => `  ${i + 1}. ${x}`).join("\n");
  const shots = (b.shotList || [])
    .map((x, i) => `  ${i + 1}. [${x.seconds || "?"}] ${x.action}${x.camera ? " — camera: " + x.camera : ""}`)
    .join("\n");
  return [
    `SCENEPULL BRIEF — ${new Date().toLocaleString()}`,
    `Character: ${profile?.name || b.characterName || "—"}`,
    ``,
    `SOURCE`,
    `  URL: ${s.videoUrl || "—"}`,
    `  Creator: @${s.authorHandle || "—"} (${s.platform || "—"})`,
    `  Views: ${formatNumber(s.views)} | Likes: ${formatNumber(s.likes)} | Comments: ${formatNumber(s.comments)} | Shares: ${formatNumber(s.shares)}`,
    `  Posted: ${formatDate(s.postDate)} (${timeAgo(s.postDate)})`,
    ``,
    `FORMAT`,
    `  ${b.formatName || "—"}`,
    `  Why it works: ${b.whyItWorks || "—"}`,
    `  Replicability: ${b.replicabilityScore ?? "—"}/10 — ${b.replicabilityReason || ""}`,
    ``,
    `SCENE TO RECREATE`,
    `  ${b.sceneDescription || "—"}`,
    ``,
    `SHOT LIST`,
    shots || "  —",
    ``,
    `IMAGE PROMPT (character in scene)`,
    `  ${b.imagePrompt || "—"}`,
    ``,
    `VIDEO / MOTION PROMPT`,
    `  ${b.videoPrompt || "—"}`,
    ``,
    `AUDIO`,
    `  ${b.audioSuggestion || "—"}`,
    ``,
    `HOOK OPTIONS`,
    list(b.hooks) || "  —",
    ``,
    `CAPTION`,
    `  ${b.caption || "—"}`,
    `  ${(b.hashtags || []).map((h) => "#" + String(h).replace(/^#/, "")).join(" ")}`,
    ``,
    `TWIST (make it your own)`,
    `  ${b.originalityTwist || "—"}`,
  ].join("\n");
}
