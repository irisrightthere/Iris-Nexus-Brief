import * as cheerio from "cheerio";
import { curlFetch } from "./curl-fetch";
import type { RawArticle } from "./types";

const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (compatible; IrisNexusBot/1.0; +https://github.com/irisrightthere/Iris-Nexus-Brief)",
  Accept: "text/html, application/xhtml+xml, */*",
  "Accept-Language": "ko-KR,ko;q=0.9,zh-CN;q=0.8,en;q=0.7",
};

/**
 * theqoo.net hot posts scraper.
 *
 * theqoo is a Korean Rhymix-based community behind Cloudflare. We shell
 * out to curl for a real TLS handshake (same strategy as linuxdo.ts).
 * The hot page at /hot?filter_mode=normal lists trending posts with
 * titles, links, and dates for a 24h window.
 */
export async function fetchTheQoo(
  sourceId: string,
  pageUrl: string,
  limit = 20,
): Promise<RawArticle[]> {
  const html = await curlFetch(pageUrl, HEADERS);

  if (html.length < 500) {
    throw new Error(`theqoo returned short body (${html.length} bytes) — possible block`);
  }

  const $ = cheerio.load(html);
  const articles: RawArticle[] = [];

  // Rhymix hot list: usually <table> or <ul> with title links.
  // Selectors ordered by specificity — first match wins.
  const rows = $(
    'a[href*="/hot/" i], a[href*="/document/" i], .board_list a[href*="document_srl"], .hot_article a[href*="document_srl"], .title a'
  );

  const seen = new Set<string>();
  rows.each((_, el) => {
    const $a = $(el);
    const href = $a.attr("href")?.trim();
    if (!href) return;
    // Resolve relative URLs
    const url = href.startsWith("http") ? href : `https://theqoo.net${href.startsWith("/") ? "" : "/"}${href}`;
    if (seen.has(url) || seen.size >= limit) return;
    seen.add(url);

    const title = $a.text().replace(/\s+/g, " ").trim();
    if (!title || title.length < 3) return;

    // Try to find sibling excerpt
    const row = $a.closest("tr, li, div");
    const excerptEl = row.find(".excerpt, .content, .comment, td.content, .board_content");
    const excerpt = excerptEl.text().replace(/\s+/g, " ").trim().slice(0, 300) || undefined;

    // Try to find date
    const dateEl = row.find(".time, .date, .regdate, td.time");
    const dateStr = dateEl.text().replace(/\s+/g, " ").trim();
    const publishedAt = dateStr ? parseKoreanDate(dateStr) : undefined;

    articles.push({
      sourceId,
      title,
      url,
      excerpt,
      publishedAt,
      category: "entertainment",
    });
  });

  if (articles.length === 0) {
    throw new Error("theqoo: no articles matched — site structure may have changed");
  }

  return articles;
}

function parseKoreanDate(s: string): Date | undefined {
  // Rhymix formats: "2026-05-27 14:30:00" or "2026.05.27 14:30" or "5시간 전"
  const m = s.match(/(\d{4})[-.](\d{2})[-.](\d{2})\s+(\d{2}):(\d{2})/);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+09:00`);

  // "N시간 전" (N hours ago), "N분 전" (N min ago)
  const hourAgo = s.match(/(\d+)\s*시간\s*전/);
  if (hourAgo) {
    const d = new Date();
    d.setHours(d.getHours() - parseInt(hourAgo[1]));
    return d;
  }
  const minAgo = s.match(/(\d+)\s*분\s*전/);
  if (minAgo) {
    const d = new Date();
    d.setMinutes(d.getMinutes() - parseInt(minAgo[1]));
    return d;
  }
  return undefined;
}
