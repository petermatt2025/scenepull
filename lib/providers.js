// BYOK provider layer: Anthropic, OpenAI, Google Gemini, OpenRouter.
// All calls go straight from the browser to the provider with the user's key.

export const PROVIDERS = {
  anthropic: {
    label: "Anthropic (Claude)",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyHint: "Starts with sk-ant-",
    // Fallback list; "Refresh models" pulls the live list from your account.
    fallbackModels: [
      { id: "claude-opus-5-5", label: "Claude Opus 5.5 (best quality)" },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (recommended)" },
      { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (fastest)" },
      { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
    ],
    defaultModel: "claude-sonnet-5-5",
  },
  openai: {
    label: "OpenAI (GPT)",
    keyUrl: "https://platform.openai.com/api-keys",
    keyHint: "Starts with sk-",
    fallbackModels: [],
    defaultModel: "",
  },
  gemini: {
    label: "Google Gemini",
    keyUrl: "https://aistudio.google.com/app/apikey",
    keyHint: "Starts with AIza",
    fallbackModels: [],
    defaultModel: "",
  },
  openrouter: {
    label: "OpenRouter (any model)",
    keyUrl: "https://openrouter.ai/settings/keys",
    keyHint: "Starts with sk-or-",
    fallbackModels: [{ id: "openrouter/auto", label: "Auto (OpenRouter picks)" }],
    defaultModel: "openrouter/auto",
  },
};

export class ProviderError extends Error {
  constructor(message, { status, provider } = {}) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.provider = provider;
  }
}

async function readError(res, provider) {
  let detail = "";
  try {
    const j = await res.json();
    detail = j?.error?.message || j?.error?.type || j?.message || JSON.stringify(j).slice(0, 300);
  } catch {
    try { detail = (await res.text()).slice(0, 300); } catch {}
  }
  const friendly = {
    400: "The request was rejected",
    401: "Your API key was rejected — check it in Settings",
    403: "Your key does not have access to this model",
    404: "Model not found — pick another model in Settings",
    429: "Rate limit or out of credit on your provider account",
    500: "The provider had a server error — try again",
    529: "The provider is overloaded — try again in a moment",
  }[res.status] || `Request failed (${res.status})`;
  return new ProviderError(`${friendly}${detail ? ": " + detail : ""}`, { status: res.status, provider });
}

// ---------------- model listing ----------------

function prettyId(id) {
  return id.replace(/^models\//, "");
}

// Newest-looking first: sort by embedded version numbers descending.
function versionSort(a, b) {
  const nums = (s) => (s.match(/\d+(\.\d+)?/g) || []).map(Number);
  const na = nums(a.id), nb = nums(b.id);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (nb[i] ?? -1) - (na[i] ?? -1);
    if (d) return d;
  }
  return a.id.localeCompare(b.id);
}

export async function listModels(provider, apiKey) {
  if (provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
    });
    if (!res.ok) throw await readError(res, provider);
    const j = await res.json();
    return (j.data || []).map((m) => ({ id: m.id, label: m.display_name || m.id }));
  }

  if (provider === "openai") {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw await readError(res, provider);
    const j = await res.json();
    const skip = /(embedding|whisper|tts|dall-e|image|audio|realtime|transcribe|moderation|search|davinci|babbage|instruct|codex|computer-use|sora)/i;
    return (j.data || [])
      .filter((m) => /^(gpt|o\d|chatgpt)/i.test(m.id) && !skip.test(m.id))
      .map((m) => ({ id: m.id, label: m.id }))
      .sort(versionSort);
  }

  if (provider === "gemini") {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(apiKey)}`
    );
    if (!res.ok) throw await readError(res, provider);
    const j = await res.json();
    return (j.models || [])
      .filter(
        (m) =>
          (m.supportedGenerationMethods || []).includes("generateContent") &&
          /gemini/i.test(m.name) &&
          !/(embedding|image-generation|tts|live|audio)/i.test(m.name)
      )
      .map((m) => ({ id: prettyId(m.name), label: m.displayName || prettyId(m.name) }))
      .sort(versionSort);
  }

  if (provider === "openrouter") {
    const res = await fetch("https://openrouter.ai/api/v1/models");
    if (!res.ok) throw await readError(res, provider);
    const j = await res.json();
    const models = (j.data || [])
      .filter((m) => (m.architecture?.output_modalities || ["text"]).includes("text"))
      .sort((a, b) => (b.created || 0) - (a.created || 0))
      .map((m) => ({
        id: m.id,
        label: m.name || m.id,
        vision: (m.architecture?.input_modalities || []).includes("image"),
      }));
    return [{ id: "openrouter/auto", label: "Auto (OpenRouter picks)" }, ...models];
  }

  throw new ProviderError("Unknown provider: " + provider);
}

// ---------------- chat call ----------------
// images: array of { mime: "image/jpeg", data: base64 (no prefix) }

export async function callLLM({ provider, apiKey, model, system, user, images = [], maxTokens = 4000, json = true, signal }) {
  if (!apiKey) throw new ProviderError("No API key set for " + (PROVIDERS[provider]?.label || provider));
  if (!model) throw new ProviderError("No model selected — open Settings and pick a model.");

  if (provider === "anthropic") {
    const content = [
      ...images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.mime, data: im.data } })),
      { type: "text", text: user },
    ];
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content }],
      }),
    });
    if (!res.ok) throw await readError(res, provider);
    const j = await res.json();
    return (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  }

  if (provider === "openai" || provider === "openrouter") {
    const url =
      provider === "openai"
        ? "https://api.openai.com/v1/chat/completions"
        : "https://openrouter.ai/api/v1/chat/completions";
    const content = [
      { type: "text", text: user },
      ...images.map((im) => ({ type: "image_url", image_url: { url: `data:${im.mime};base64,${im.data}` } })),
    ];
    const headers = { "content-type": "application/json", Authorization: `Bearer ${apiKey}` };
    if (provider === "openrouter") {
      headers["HTTP-Referer"] = "https://scenepull.app";
      headers["X-Title"] = "ScenePull";
    }
    const body = {
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: images.length ? content : user },
      ],
    };
    if (provider === "openai") body.max_completion_tokens = maxTokens;
    else body.max_tokens = maxTokens;
    if (json) body.response_format = { type: "json_object" };

    let res = await fetch(url, { method: "POST", signal, headers, body: JSON.stringify(body) });
    // Some models reject response_format or images; retry once without them.
    if (res.status === 400 && (json || images.length)) {
      delete body.response_format;
      res = await fetch(url, { method: "POST", signal, headers, body: JSON.stringify(body) });
    }
    if (!res.ok) throw await readError(res, provider);
    const j = await res.json();
    const msg = j.choices?.[0]?.message?.content;
    return Array.isArray(msg) ? msg.map((p) => p.text || "").join("") : msg || "";
  }

  if (provider === "gemini") {
    const parts = [
      ...images.map((im) => ({ inline_data: { mime_type: im.mime, data: im.data } })),
      { text: user },
    ];
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts }],
          generationConfig: {
            maxOutputTokens: maxTokens,
            ...(json ? { responseMimeType: "application/json" } : {}),
          },
        }),
      }
    );
    if (!res.ok) throw await readError(res, provider);
    const j = await res.json();
    if (j.promptFeedback?.blockReason) {
      throw new ProviderError("Gemini blocked this request: " + j.promptFeedback.blockReason, { provider });
    }
    return (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  }

  throw new ProviderError("Unknown provider: " + provider);
}

export async function testKey(provider, apiKey) {
  const models = await listModels(provider, apiKey);
  if (provider === "openrouter") {
    // Model list is public on OpenRouter; check the key itself.
    const res = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) throw await readError(res, provider);
  }
  return models;
}
