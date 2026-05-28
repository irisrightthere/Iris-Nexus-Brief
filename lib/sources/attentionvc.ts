import type { RawArticle } from "./types";

/**
 * AttentionVC tracks viral X (Twitter) posts. Their site is a CSR Next.js
 * shell, but the actual data flows through a public Cloud Run REST API
 * (no auth, no rate limit observed). We hit the leaderboard endpoint
 * filtered to category=ai, window=24h.
 *
 * Discovered by reading the site's webpack chunk 311 — base URL + path
 * templates are inlined there. Subject to change if attentionvc rolls a
 * new backend, but as long as the site itself uses this API, we're fine.
 */
const BASE =
  "https://reply-vc-90459984647.us-central1.run.app/v1/articles/leaderboard";

interface AvcAuthor {
  handle: string;
  name?: string;
  followers?: number;
  accountBasedIn?: string;
  isBlueVerified?: boolean;
}

interface AvcEntry {
  rank: number;
  tweetId: string;
  title: string;
  tweetCreatedAt: string;
  author: AvcAuthor;
  viewCount?: number;
  likeCount?: number;
  retweetCount?: number;
  replyCount?: number;
  previewText?: string;
  coverImageUrl?: string;
  category?: string;
  subcategory?: string;
  tags?: string[];
  lang?: string;
  langsDetected?: string[];
}

interface AvcResponse {
  entries: AvcEntry[];
  updatedAt?: string;
  totalCount?: number;
}

function compactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * Build a one-line metadata string shown above the excerpt. Mirrors the
 * `meta` convention used by GitHub Trending ("Language · ★stars · forks").
 */
function buildMeta(e: AvcEntry): string {
  const parts: string[] = [`@${e.author.handle}`];
  if (typeof e.author.followers === "number") {
    parts.push(`${compactNumber(e.author.followers)} 粉丝`);
  }
  if (typeof e.viewCount === "number") {
    parts.push(`${compactNumber(e.viewCount)} 阅`);
  }
  if (typeof e.likeCount === "number") {
    parts.push(`${compactNumber(e.likeCount)} 赞`);
  }
  if (typeof e.retweetCount === "number" && e.retweetCount > 0) {
    parts.push(`${compactNumber(e.retweetCount)} 转`);
  }
  return parts.join(" · ");
}

/**
 * The API's `lang` query param is best-effort — Japanese/Korean tweets
 * still slip through even with `lang=en`. Filter client-side using
 * `langsDetected` (most reliable) with `lang` as fallback. `zxx` means
 * "no linguistic content" (image/code-only tweets) — keep those since
 * they're still indexable AI content.
 */
function isEnglish(e: AvcEntry): boolean {
  if (e.langsDetected && e.langsDetected.length > 0) {
    return e.langsDetected.includes("en");
  }
  if (e.lang === "en" || e.lang === "zxx") return true;
  return false;
}

export async function fetchAttentionVc(
  sourceId: string,
  apiCategory: string,
  articleCategory: RawArticle["category"],
  limit = 20,
): Promise<RawArticle[]> {
  // window=24h — 3d was returning ~1 result (API-side bug), 24h reliably
  // returns 30. Limit=30 gives headroom for isEnglish() filtering while
  // still satisfying the downstream cap of 20.
  const url = `${BASE}?window=24h&category=${encodeURIComponent(apiCategory)}&lang=en&limit=30`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; IrisNexusBot/1.0)",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`attentionvc HTTP ${res.status}`);
  }
  const data = (await res.json()) as AvcResponse;
  const entries = (data.entries ?? []).filter(isEnglish);
  return entries.slice(0, limit).map((e) => ({
    sourceId,
    title: e.title,
    url: `https://x.com/${e.author.handle}/status/${e.tweetId}`,
    excerpt: e.previewText?.replace(/\s+/g, " ").trim().slice(0, 300),
    publishedAt: e.tweetCreatedAt ? new Date(e.tweetCreatedAt) : undefined,
    category: articleCategory,
    meta: buildMeta(e),
  }));
}
