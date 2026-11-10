// Builds the prompts, calls the chosen provider, parses the JSON brief.
import { callLLM } from "./providers.js";

export function buildSystemPrompt() {
  return `You are ScenePull, a short-form video producer who helps creators make videos starring their own original AI character.

You receive: metadata scraped from a trending TikTok or Instagram video (views, likes, caption, hashtags, audio, timestamps), optional screenshots of the video, optional notes from the creator, and the creator's saved character profile.

Your job: work out the REPEATABLE FORMAT behind the trending video (the structure, beat timing, camera framing, joke or emotional turn) and write a production brief that puts the creator's character into a fresh version of that format.

Rules:
- Recreate the FORMAT, never the specific content. Do not copy the original caption, dialogue, likeness, logo, or trademark. Never describe or imitate a real, identifiable person; the character must be the creator's own.
- Keep the character visually consistent: always restate their fixed visual traits (face, hair, outfit, signature item) in the image prompt so every generation matches.
- Image prompts must be a single, self-contained paragraph usable in any modern image generator: subject, action, setting, wardrobe, lighting, lens/camera, composition, aspect ratio 9:16, photoreal unless the profile says otherwise.
- Video prompts describe motion for an image-to-video tool: what moves, camera move, duration, pacing.
- Hooks must work in the first 1–2 seconds and be under 12 words.
- Captions follow platform norms (TikTok: short, curiosity/punchline; Instagram: one strong line + optional second line). Do not include hashtags inside the caption field.
- If screenshots or metadata are thin, make sensible assumptions and say so in "assumptions".
- Be concrete and specific. No filler.

Return ONLY valid JSON (no markdown fences) with exactly these keys:
{
  "formatName": "short name for the format, e.g. 'Deadpan reaction to absurd situation'",
  "whyItWorks": "1–2 sentences on the psychological hook driving views",
  "replicabilityScore": 1-10 integer (10 = trivial to recreate with AI image+video tools),
  "replicabilityReason": "one sentence",
  "sceneDescription": "3 lines max: what happens in the new video with the creator's character",
  "shotList": [ { "seconds": "0-2", "action": "...", "camera": "...", "onScreenText": "..." } ],
  "imagePrompt": "key-frame image prompt with the character placed in the scene",
  "videoPrompt": "image-to-video motion prompt",
  "audioSuggestion": "sound / music / voice direction (use trending-sound style, not the copyrighted track)",
  "hooks": ["hook 1", "hook 2", "hook 3"],
  "caption": "platform-ready caption",
  "hashtags": ["tag", "tag"],
  "originalityTwist": "the one change that makes this clearly the creator's own take",
  "engagementBait": "a comment prompt or debate angle to drive replies (e.g. 'is he real?')",
  "assumptions": "what you had to guess, or empty string"
}`;
}

function fmt(n) {
  return n == null ? "unknown" : Number(n).toLocaleString("en-US");
}

export function buildUserPrompt(scraped, profile, opts = {}) {
  const s = scraped || {};
  const p = profile || {};
  const ageHrs = s.postDate ? Math.round((Date.now() - new Date(s.postDate)) / 36e5) : null;
  return `PLATFORM: ${s.platform || "unknown"}

TRENDING VIDEO
- URL: ${s.videoUrl || "unknown"}
- Creator: @${s.authorHandle || "unknown"}
- Views: ${fmt(s.views)} | Likes: ${fmt(s.likes)} | Comments: ${fmt(s.comments)} | Shares: ${fmt(s.shares)} | Saves: ${fmt(s.saves)}
- Posted: ${s.postDate || "unknown"}${ageHrs != null ? ` (~${ageHrs} hours ago)` : ""}
- Duration: ${s.durationSec ? s.durationSec + "s" : "unknown"}
- Audio: ${s.music || "unknown"}
- Original caption: ${s.caption ? JSON.stringify(s.caption) : "none"}
- Hashtags: ${(s.hashtags || []).join(", ") || "none"}
- On-screen text: ${s.overlayText || "none detected"}
- Screenshots attached: ${opts.imageCount || 0}

CREATOR'S NOTES ON WHAT HAPPENS IN THE VIDEO
${opts.notes?.trim() || "(none — infer from screenshots and metadata)"}

CHARACTER PROFILE
- Name: ${p.name || "Unnamed character"}
- Fixed appearance (must appear in every image prompt): ${p.appearance || "not specified"}
- Personality / voice: ${p.personality || "not specified"}
- Recurring setting: ${p.recurringSet || "none"}
- Visual style: ${p.style || "photoreal, smartphone-shot"}
- Niche / audience: ${p.niche || "general entertainment"}
- Things to avoid: ${p.avoid || "none"}

OUTPUT SETTINGS
- Number of hooks: ${opts.hookCount || 3}
- Language: ${opts.language || "English"}
- Target platform for the new video: ${opts.targetPlatform || s.platform || "tiktok"}
${opts.extraDirection ? `- Extra direction from creator: ${opts.extraDirection}` : ""}

Write the brief now as JSON.`;
}

export function parseBriefResponse(rawText) {
  const raw = String(rawText || "").trim();
  const attempts = [
    raw,
    raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, ""),
    raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1),
  ];
  for (const a of attempts) {
    try {
      const j = JSON.parse(a);
      if (j && typeof j === "object") {
        return {
          ...j,
          hooks: Array.isArray(j.hooks) ? j.hooks : j.hook ? [j.hook] : [],
          hashtags: Array.isArray(j.hashtags) ? j.hashtags.map((h) => String(h).replace(/^#/, "")) : [],
          shotList: Array.isArray(j.shotList) ? j.shotList : [],
          rawText: raw,
          parsed: true,
        };
      }
    } catch {}
  }
  return {
    parsed: false,
    rawText: raw,
    sceneDescription: raw,
    hooks: [],
    hashtags: [],
    shotList: [],
  };
}

export async function generateBrief({ scraped, profile, provider, apiKey, model, images, notes, prefs, extraDirection, targetPlatform, signal }) {
  const system = buildSystemPrompt();
  const user = buildUserPrompt(scraped, profile, {
    notes,
    imageCount: images?.length || 0,
    hookCount: prefs?.hookCount,
    language: prefs?.language,
    extraDirection,
    targetPlatform,
  });
  const raw = await callLLM({ provider, apiKey, model, system, user, images, maxTokens: 4000, json: true, signal });
  return parseBriefResponse(raw);
}

// Quick regenerate of just hooks + caption.
export async function regenerateCopy({ brief, profile, provider, apiKey, model, prefs, platform, signal }) {
  const system = `You write short-form video hooks and captions. Return ONLY JSON: {"hooks": [...], "caption": "...", "hashtags": [...]}. Hooks under 12 words. No hashtags inside caption. Language: ${prefs?.language || "English"}.`;
  const user = `Platform: ${platform}
Character: ${profile?.name} — ${profile?.personality || ""}
Format: ${brief.formatName}
Scene: ${brief.sceneDescription}
Previous hooks (write different ones): ${(brief.hooks || []).join(" | ")}
Give ${prefs?.hookCount || 3} fresh hooks, a new caption and 5-8 hashtags.`;
  const raw = await callLLM({ provider, apiKey, model, system, user, maxTokens: 1000, json: true, signal });
  return parseBriefResponse(raw);
}
