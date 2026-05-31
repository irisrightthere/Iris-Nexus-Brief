import * as cheerio from "cheerio";
import type { RawArticle } from "./types";

/**
 * STARTO ENTERTAINMENT news scraper.
 *
 * starto.jp/s/p/news/list is server-rendered HTML. Each article is an
 * <li class="p-in_news__list-item"> containing date (.c-date), category
 * tag (.c-tag), title (.c-ttl-2), and an optional external link
 * (a.c-news__ttl-inner). Articles without external links are skipped —
 * they're event/goods announcements with no news article to read.
 */
export async function fetchStartoNews(
  sourceId: string,
  baseUrl: string,
  limit = 20,
): Promise<RawArticle[]> {
  const articles: RawArticle[] = [];
  const seen = new Set<string>();

  // Page 0 = default (latest), page 1+ = &page=N.
  // The STARTO site treats the default URL as page 1 of latest news;
  // appending &page=1 actually returns page 2 (older content).
  for (let page = 0; page < 3 && articles.length < limit; page++) {
    const url = page === 0 ? baseUrl : `${baseUrl}&page=${page}`;
    const resp = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; IrisNexusBot/1.0; +https://github.com/irisrightthere/Iris-Nexus-Brief)",
        Accept: "text/html, */*",
        "Accept-Language": "ja,en;q=0.9",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) throw new Error(`STARTO page ${page} HTTP ${resp.status}`);

    const html = await resp.text();
    const $ = cheerio.load(html);

    const items = $("li.p-in_news__list-item");
    if (items.length === 0) break;

    items.each((_, el) => {
      if (articles.length >= limit) return;

      const $item = $(el);
      const $link = $item.find("a.c-news__ttl-inner");
      const href = ($link.attr("href") ?? "").trim();
      if (!href) return; // skip entries without external links

      const $title = $link.find(".c-ttl-2, span");
      const title = ($title.text() || $link.text()).replace(/\s+/g, " ").trim();
      if (!title || title.length < 5) return;

      if (seen.has(href)) return;
      seen.add(href);

      const dateStr = $item.find(".c-date").text().trim();

      articles.push({
        sourceId,
        title,
        url: href,
        publishedAt: dateStr ? parseStartoDate(dateStr) : undefined,
        category: "entertainment",
      });
    });
  }

  if (articles.length === 0) {
    throw new Error("starto: no articles matched — site structure may have changed");
  }
  return articles;
}

function parseStartoDate(s: string): Date | undefined {
  const m = s.match(/(\d{4})\.(\d{2})\.(\d{2})/);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00+09:00`);
  return undefined;
}
