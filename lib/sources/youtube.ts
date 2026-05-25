import * as cheerio from "cheerio";
import Parser from "rss-parser";
import type { RawArticle } from "./types";

const parser = new Parser({
  timeout: 15000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (compatible; IrisNexusBot/1.0; +https://github.com/)",
  },
  customFields: {
    item: [["media:group", "media:thumbnail", { attr: "url" }]],
  },
});

/**
 * Fetch recent videos from a YouTube channel.
 *
 * Strategy: fetch the channel page → extract the RSS <link> tag with
 * cheerio → parse the RSS feed with rss-parser.  Two HTTP round-trips
 * but zero API keys and zero rate limits.
 */
export async function fetchYoutube(sourceId: string, channelUrl: string, category: RawArticle["category"]): Promise<RawArticle[]> {
  // 1. Fetch channel page, extract RSS URL
  const pageResp = await fetch(channelUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; IrisNexusBot/1.0; +https://github.com/)",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!pageResp.ok) {
    throw new Error(`Channel page returned ${pageResp.status} for ${channelUrl}`);
  }
  const html = await pageResp.text();
  const $ = cheerio.load(html);

  const rssLink = $('link[type="application/rss+xml"]').attr("href");
  if (!rssLink) {
    throw new Error(`No RSS link found on channel page ${channelUrl}`);
  }

  // 2. Parse the RSS feed
  const feedUrl = rssLink.startsWith("http") ? rssLink : `https://www.youtube.com${rssLink}`;
  const feed = await parser.parseURL(feedUrl);

  return (feed.items ?? []).slice(0, 10).map((item) => ({
    sourceId,
    title: (item.title ?? "").trim(),
    url: (item.link ?? "").trim(),
    excerpt: (item.contentSnippet ?? item.content ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
    publishedAt: item.isoDate ? new Date(item.isoDate) : undefined,
    category,
    // @ts-expect-error rss-parser custom field — media:thumbnail url
    thumbnail: (item["media:group"]?.["media:thumbnail"]?.url as string) ?? undefined,
  }));
}
