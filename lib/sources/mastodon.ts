import * as cheerio from "cheerio";
import type { RawArticle } from "./types";

/**
 * Mastodon RSS fetcher for Natalie.mu news.
 *
 * Natalie's official site is a Vue SPA with no RSS, but they run a Mastodon
 * bot (@natalie@chaosphere.hostdon.jp) that auto-posts every article. Mastodon
 * natively outputs RSS 2.0 at /@username.rss.
 *
 * Mastodon's RSS lacks <title> — the article title + link are embedded in
 * <description> as HTML: 【 #tag 】 記事タイトル https://natalie.mu/...
 *
 * When `keywords` is provided, articles are filtered to only those whose
 * description contains at least one keyword (case-insensitive match against
 * hashtags, title, and body text).
 */
export async function fetchMastodonNatalie(
  sourceId: string,
  feedUrl: string,
  limit = 20,
  keywords?: string[],
): Promise<RawArticle[]> {
  const resp = await fetch(feedUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; IrisNexusBot/1.0; +https://github.com/irisrightthere/Iris-Nexus-Brief)",
      Accept: "application/rss+xml, application/xml, text/xml, */*",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`Mastodon RSS HTTP ${resp.status}`);

  const xml = await resp.text();
  const $ = cheerio.load(xml, { xmlMode: true });
  const articles: RawArticle[] = [];

  $("item").each((_, el) => {
    if (articles.length >= limit) return;

    const $item = $(el);
    const descHtml = $item.find("description").text() || "";
    const $desc = cheerio.load(descHtml);
    const descText = $desc.text().trim();

    // Pattern: 【 #tag1 #tag2 】 article title https://natalie.mu/...
    const natalieMatch = descText.match(
      /【[^】]*】\s*(.+?)\s*(https:\/\/natalie\.mu\/\S+)/,
    );
    if (!natalieMatch) return;

    const title = natalieMatch[1].trim();
    const url = natalieMatch[2].trim();
    if (!title || title.length < 3) return;

    // Keyword filter (case-insensitive, matches against full description)
    if (keywords && keywords.length > 0) {
      const lower = descText.toLowerCase();
      if (!keywords.some((kw) => lower.includes(kw.toLowerCase()))) return;
    }

    const pubDate = $item.find("pubDate").text();
    const publishedAt = pubDate ? new Date(pubDate) : undefined;

    articles.push({
      sourceId,
      title,
      url,
      excerpt: descText.slice(0, 300),
      publishedAt,
      category: "entertainment",
    });
  });

  if (articles.length === 0) {
    throw new Error(`mastodon-natalie: no articles matched (keywords=${keywords?.join(",") ?? "none"})`);
  }
  return articles;
}
