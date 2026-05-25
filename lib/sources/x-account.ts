import Parser from "rss-parser";
import type { RawArticle } from "./types";

const parser = new Parser({
  timeout: 15000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (compatible; IrisNexusBot/1.0; +https://github.com/)",
  },
});

/**
 * Fetch recent tweets for an X account via RSS bridge.
 *
 * Default strategy: RSSHub's Twitter user timeline route.
 * Set X_RSS_BASE_URL env var to point at your own RSSHub instance
 * or any compatible bridge (nitter, rss.app, fetchrss.com, etc.).
 * Falls back to the public rsshub.app instance.
 *
 * Each source entry needs a `handle` field (the X handle without @).
 * The fetcher constructs: <base>/twitter/user/<handle>
 */
export async function fetchXAccount(sourceId: string, handle: string, category: RawArticle["category"]): Promise<RawArticle[]> {
  const base = process.env.X_RSS_BASE_URL ?? "https://rsshub.app";
  const feedUrl = `${base.replace(/\/$/, "")}/twitter/user/${encodeURIComponent(handle)}`;

  const feed = await parser.parseURL(feedUrl);

  return (feed.items ?? []).slice(0, 10).map((item) => ({
    sourceId,
    title: (item.title ?? "").trim(),
    url: (item.link ?? "").trim(),
    excerpt: (item.contentSnippet ?? item.content ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
    publishedAt: item.isoDate ? new Date(item.isoDate) : undefined,
    category,
  }));
}
