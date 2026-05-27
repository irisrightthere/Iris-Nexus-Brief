import * as cheerio from "cheerio";
import type { RawArticle } from "./types";

/**
 * Modelpress entertainment RSS fetcher.
 *
 * mdpr.jp provides dedicated RSS feeds at feed.mdpr.jp. The entertainment
 * feed covers drama, music, cinema, TV, K-ent, and more.
 */
export async function fetchModelpress(
  sourceId: string,
  feedUrl: string,
  limit = 20,
): Promise<RawArticle[]> {
  const resp = await fetch(feedUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; IrisNexusBot/1.0; +https://github.com/irisrightthere/Iris-Nexus-Brief)",
      Accept: "application/rss+xml, application/xml, text/xml, */*",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`modelpress RSS HTTP ${resp.status}`);

  const xml = await resp.text();
  const $ = cheerio.load(xml, { xmlMode: true });
  const articles: RawArticle[] = [];

  $("item").each((_, el) => {
    if (articles.length >= limit) return;

    const $item = $(el);
    const title = $item.find("title").text().trim();
    const link = $item.find("link").text().trim();
    const descHtml = $item.find("description").text();
    const pubDate = $item.find("pubDate").text();

    // Strip HTML from description for excerpt
    const excerpt = cheerio.load(descHtml ?? "").text().replace(/\s+/g, " ").trim().slice(0, 300);

    if (!title || !link) return;

    articles.push({
      sourceId,
      title,
      url: link,
      excerpt: excerpt || undefined,
      publishedAt: pubDate ? new Date(pubDate) : undefined,
      category: "entertainment",
    });
  });

  if (articles.length === 0) {
    throw new Error("modelpress: no articles found in RSS");
  }
  return articles;
}
