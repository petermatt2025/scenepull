// ScenePull DOM scraper (classic script, loaded as a content script).
// Exposes globalThis.ScenePullScraper. Every field is optional: if a selector
// breaks after a TikTok / Instagram redesign we return null instead of throwing.
(() => {
  const safe = (fn, fallback = null) => {
    try {
      const v = fn();
      return v === undefined || v === "" ? fallback : v;
    } catch {
      return fallback;
    }
  };
  const txt = (sel, root = document) =>
    safe(() => root.querySelector(sel)?.innerText?.trim() || null);

  // "1.2M" / "34,521" / "12K" -> 1200000 / 34521 / 12000
  function parseCount(str) {
    if (str == null) return null;
    if (typeof str === "number") return str;
    const m = String(str).replace(/,/g, "").match(/([\d.]+)\s*([KMB])?/i);
    if (!m) return null;
    const n = parseFloat(m[1]);
    const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || "").toUpperCase()] || 1;
    return Math.round(n * mult);
  }

  function detectPlatform(url) {
    try {
      const h = new URL(url).hostname;
      if (h.endsWith("tiktok.com")) return "tiktok";
      if (h.endsWith("instagram.com")) return "instagram";
    } catch {}
    return "unsupported";
  }

  // TikTok video IDs encode the upload time: id >> 32 = unix seconds.
  function tiktokIdToDate(id) {
    try {
      const secs = Number(BigInt(id) >> 32n);
      if (secs > 1.4e9 && secs < 4e9) return new Date(secs * 1000).toISOString();
    } catch {}
    return null;
  }

  function tiktokVideoIdFromUrl(url) {
    return safe(() => url.match(/\/video\/(\d{8,})/)?.[1]);
  }

  // TikTok ships the full item JSON for direct /video/ loads.
  function tiktokHydration(videoId) {
    return safe(() => {
      const el = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
      if (!el) return null;
      const data = JSON.parse(el.textContent);
      const item =
        data?.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo?.itemStruct;
      if (!item || (videoId && item.id !== videoId)) return null;
      return item;
    });
  }

  // Find the video currently in view (feed pages render many).
  function activeTikTokContainer() {
    return safe(() => {
      const vids = [...document.querySelectorAll("video")];
      const mid = window.innerHeight / 2;
      let best = null;
      let bestDist = Infinity;
      for (const v of vids) {
        const r = v.getBoundingClientRect();
        if (r.height < 100) continue;
        const d = Math.abs(r.top + r.height / 2 - mid);
        if (d < bestDist) {
          bestDist = d;
          best = v;
        }
      }
      return best?.closest("article, [data-e2e='recommend-list-item-container'], section") || null;
    });
  }

  function scrapeTikTok() {
    const url = location.href;
    let videoId = tiktokVideoIdFromUrl(url);
    const root = activeTikTokContainer() || document;

    // Feed pages: pick up the active video's link if the URL has none.
    if (!videoId) {
      videoId = safe(() =>
        root.querySelector("a[href*='/video/']")?.href.match(/\/video\/(\d+)/)?.[1]
      );
    }

    const item = tiktokHydration(videoId);
    const stats = item?.statsV2 || item?.stats || {};

    const views = parseCount(stats.playCount) ?? parseCount(txt("[data-e2e='video-views']", root));
    const likes =
      parseCount(stats.diggCount) ??
      parseCount(txt("[data-e2e='like-count']", root) || txt("[data-e2e='browse-like-count']"));
    const comments =
      parseCount(stats.commentCount) ??
      parseCount(txt("[data-e2e='comment-count']", root) || txt("[data-e2e='browse-comment-count']"));
    const shares = parseCount(stats.shareCount) ?? parseCount(txt("[data-e2e='share-count']", root));
    const saves = parseCount(stats.collectCount) ?? parseCount(txt("[data-e2e='undefined-count']", root));

    const postDate =
      (item?.createTime ? new Date(item.createTime * 1000).toISOString() : null) ||
      tiktokIdToDate(videoId) ||
      safe(() => document.querySelector("time")?.getAttribute("datetime"));

    const caption =
      item?.desc ||
      txt("[data-e2e='browse-video-desc']") ||
      txt("[data-e2e='video-desc']", root);

    const authorHandle =
      item?.author?.uniqueId ||
      txt("[data-e2e='browse-username']") ||
      txt("[data-e2e='video-author-uniqueid']", root) ||
      safe(() => url.match(/@([\w.]+)/)?.[1]);

    const music =
      item?.music?.title
        ? `${item.music.title}${item.music.authorName ? " — " + item.music.authorName : ""}`
        : txt("[data-e2e='browse-music']") || txt("[data-e2e='video-music']", root);

    const hashtags = safe(
      () => (item?.textExtra || []).map((t) => t.hashtagName).filter(Boolean),
      []
    );

    // On-screen text stickers, when TikTok exposes them.
    const overlayText = safe(
      () =>
        (item?.stickersOnItem || [])
          .flatMap((s) => s.stickerText || [])
          .join(" | "),
      ""
    );

    const duration = item?.video?.duration ?? safe(() => Math.round(root.querySelector("video")?.duration)) ?? null;

    return {
      platform: "tiktok",
      videoUrl: videoId && authorHandle ? `https://www.tiktok.com/@${authorHandle}/video/${videoId}` : url,
      videoId: videoId || null,
      authorHandle: authorHandle || null,
      views, likes, comments, shares, saves,
      postDate: postDate || null,
      caption: caption || "",
      hashtags: hashtags || [],
      music: music || null,
      overlayText: overlayText || "",
      durationSec: Number.isFinite(duration) ? duration : null,
      scrapedAt: new Date().toISOString(),
    };
  }

  // ---------- Instagram ----------
  const IG_APP_ID = "936619743392459"; // public web-app id Instagram's own site sends
  const IG_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const igCache = new Map(); // shortcode -> { at, data }

  function igShortcode(url) {
    return safe(() => url.match(/\/(?:reel|reels|p|tv)\/([\w-]+)/)?.[1]);
  }

  function igMediaId(shortcode) {
    return safe(() => {
      let id = 0n;
      for (const ch of shortcode.slice(0, 11)) {
        const i = IG_ALPHABET.indexOf(ch);
        if (i < 0) return null;
        id = id * 64n + BigInt(i);
      }
      return id.toString();
    });
  }

  // Same request Instagram's own web app makes. Uses the viewer's logged-in session.
  async function igFetchMedia(shortcode) {
    const hit = igCache.get(shortcode);
    if (hit && Date.now() - hit.at < 60_000) return hit.data;
    const mediaId = igMediaId(shortcode);
    if (!mediaId) return null;
    try {
      const res = await fetch(`/api/v1/media/${mediaId}/info/`, {
        credentials: "include",
        headers: { "X-IG-App-ID": IG_APP_ID, "X-Requested-With": "XMLHttpRequest" },
      });
      if (!res.ok) return null;
      const item = (await res.json())?.items?.[0] || null;
      if (item) igCache.set(shortcode, { at: Date.now(), data: item });
      return item;
    } catch {
      return null;
    }
  }

  // A reel opened from a profile/feed shows in a dialog on top of the old page.
  function igRoot() {
    const dialogs = [...document.querySelectorAll("div[role='dialog']")].filter(
      (d) => d.querySelector("video, time[datetime], article")
    );
    if (dialogs.length) return dialogs[dialogs.length - 1];
    const main = document.querySelector("main");
    return main?.querySelector("article") || main || document.body;
  }

  function igFromApi(item, url, shortcode) {
    const music =
      safe(() => {
        const m = item.clips_metadata?.music_info?.music_asset_info;
        if (m?.title) return `${m.title}${m.display_artist ? " — " + m.display_artist : ""}`;
        const o = item.clips_metadata?.original_sound_info;
        if (o) return `${o.original_audio_title || "Original audio"} — ${o.ig_artist?.username || item.user?.username || ""}`.trim();
        return null;
      });
    const caption = item.caption?.text || "";
    return {
      platform: "instagram",
      videoUrl: shortcode ? `https://www.instagram.com/reel/${shortcode}/` : url,
      videoId: shortcode || null,
      authorHandle: item.user?.username || null,
      views: item.play_count ?? item.ig_play_count ?? item.view_count ?? null,
      likes: item.like_and_view_counts_disabled ? null : item.like_count ?? null,
      comments: item.comment_count ?? null,
      shares: item.reshare_count ?? null,
      saves: null,
      postDate: item.taken_at ? new Date(item.taken_at * 1000).toISOString() : null,
      caption,
      hashtags: [...new Set((caption.match(/#[\p{L}\d_]+/gu) || []).map((h) => h.slice(1)))],
      music,
      overlayText: "",
      durationSec: Number.isFinite(item.video_duration) ? Math.round(item.video_duration) : null,
      scrapedAt: new Date().toISOString(),
      source: "api",
    };
  }

  function igFromDom(url, shortcode) {
    const root = igRoot();

    // og:description is only accurate on a direct page load (not after in-app navigation).
    const ogUrl = safe(() => document.querySelector("meta[property='og:url']")?.content || "");
    const ogFresh = !!shortcode && ogUrl.includes(shortcode);
    const og = ogFresh ? safe(() => document.querySelector("meta[property='og:description']")?.content || "", "") : "";
    const ogLikes = safe(() => og.match(/([\d.,]+[KMB]?)\s+likes?/i)?.[1]);
    const ogComments = safe(() => og.match(/([\d.,]+[KMB]?)\s+comments?/i)?.[1]);
    const ogCaption = safe(() => og.match(/:\s*["“](.*)["”]\s*\.?$/s)?.[1]);
    const ogUser = safe(() => og.match(/-\s*([\w.]+)\s+on\s/)?.[1]);

    // aria-label / visible text: "34,521 likes", "1.2M plays/views"
    const labelScan = (re) =>
      safe(() => {
        for (const el of root.querySelectorAll("[aria-label], span, a, section div")) {
          const s = el.getAttribute?.("aria-label") || el.innerText || "";
          if (s.length > 40) continue;
          const m = s.trim().match(re);
          if (m) return m[1];
        }
        return null;
      });

    const views = parseCount(labelScan(/^([\d.,]+[KMB]?)\s+(?:plays|views)$/i));
    const likes = parseCount(ogLikes) ?? parseCount(labelScan(/^([\d.,]+[KMB]?)\s+likes?$/i));
    const comments = parseCount(ogComments) ?? parseCount(labelScan(/^(?:view all\s+)?([\d.,]+[KMB]?)\s+comments?$/i));

    const postDate = safe(() => root.querySelector("time[datetime]")?.getAttribute("datetime"));

    const caption =
      safe(() => root.querySelector("h1")?.innerText?.trim()) ||
      ogCaption ||
      "";

    const authorHandle =
      ogUser ||
      safe(() => {
        for (const a of root.querySelectorAll("header a[href^='/']")) {
          const t = a.innerText?.trim();
          if (t && /^[\w.]+$/.test(t)) return t;
        }
        return null;
      }) ||
      safe(() => url.match(/instagram\.com\/([\w.]+)\/(?:reel|p)\//)?.[1]) ||
      null;

    const hashtags = [...new Set((caption.match(/#[\p{L}\d_]+/gu) || []).map((h) => h.slice(1)))];
    const duration = safe(() => Math.round(root.querySelector("video")?.duration ?? document.querySelector("video")?.duration));

    return {
      platform: "instagram",
      videoUrl: url,
      videoId: shortcode || null,
      authorHandle,
      views, likes, comments, shares: null, saves: null,
      postDate: postDate || null,
      caption,
      hashtags,
      music: labelScan(/^(.*·\s*Original audio.*)$/i),
      overlayText: "",
      durationSec: Number.isFinite(duration) ? duration : null,
      scrapedAt: new Date().toISOString(),
      source: "page",
    };
  }

  async function scrapeInstagram() {
    const url = location.href;
    const shortcode = igShortcode(url);
    const dom = igFromDom(url, shortcode);
    const item = shortcode ? await igFetchMedia(shortcode) : null;
    if (!item) return dom;
    const api = igFromApi(item, url, shortcode);
    // Fill any gaps from the page.
    for (const k of Object.keys(dom)) if (api[k] == null || api[k] === "") api[k] = dom[k];
    return api;
  }

  function isVideoPage() {
    const p = detectPlatform(location.href);
    if (p === "tiktok") return !!document.querySelector("video");
    if (p === "instagram") return /\/(reel|reels|p)\//.test(location.pathname) || !!document.querySelector("video");
    return false;
  }

  async function scrapeCurrentPage() {
    const platform = detectPlatform(location.href);
    if (platform === "tiktok") return scrapeTikTok();
    if (platform === "instagram") return await scrapeInstagram();
    return { error: "unsupported" };
  }

  globalThis.ScenePullScraper = { detectPlatform, parseCount, scrapeCurrentPage, isVideoPage, tiktokIdToDate, igMediaId };
})();
