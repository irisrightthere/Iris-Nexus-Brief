import { fetchAttentionVc } from "./attentionvc";
import { fetchGithubTrending } from "./github-trending";
import { fetchHackerNews } from "./hackernews";
import { fetchLinuxDo } from "./linuxdo";
import { fetchRss } from "./rss";
import { fetchV2ex } from "./v2ex";
import { fetchMastodonNatalie } from "./mastodon";
import { fetchTheQoo } from "./theqoo";
import { fetchYoutube } from "./youtube";
import { fetchStartoNews } from "./starto";
import { fetchModelpress } from "./modelpress";
import type { RawArticle, SourceDef } from "./types";

/** Hashtags Natalie uses for K-POP coverage. */
const K_POP_KEYWORDS = [
  "K-POP", "BTS", "TWICE", "SEVENTEEN", "NCT", "Stray Kids",
  "aespa", "ITZY", "IVE", "LE SSERAFIM", "NewJeans", "ENHYPEN",
  "TXT", "Red Velvet", "EXO", "ZEROBASEONE", "RIIZE", "BOYNEXTDOOR",
  "ILLIT", "BABYMONSTER", "BLACKPINK", "少女時代", "BIGBANG",
];

/** STARTO idol keywords for filtering Mastodon Natalie feed. */
const STARTO_KEYWORDS = [
  "STARTO", "super eight", "SixTONES", "west", "ACES",
  "Aぇ! group", "Kis-My-Ft2", "嵐", "Snow Man", "なにわ男子",
  "timelesz", "Travis Japan", "KEY TO LIT", "山下智久",
];

/** Japanese drama/film keywords for filtering Mastodon Natalie feed. */
const JP_DRAMA_KEYWORDS = ["ドラマ", "映画", "NHK", "朝ドラ", "大河"];

/**
 * Single dispatcher used by daily.ts, dry-run.ts, and the cron route.
 * Add a new branch here when introducing a non-RSS fetcher.
 */
export async function fetchSource(source: SourceDef): Promise<RawArticle[]> {
  if (source.id === "hackernews") return fetchHackerNews(source.id);
  if (source.id === "github-trending") return fetchGithubTrending(source.id);
  if (source.id === "v2ex-hot") return fetchV2ex(source.id);
  if (source.id === "linuxdo") return fetchLinuxDo(source.id);
  if (source.id.startsWith("attentionvc-")) {
    const url = new URL(source.url);
    const apiCategory = url.searchParams.get("category") ?? "ai";
    return fetchAttentionVc(source.id, apiCategory, source.category);
  }
  // Natalie Mastodon — four source entries share the same feed but filter
  // by different keywords: natalie-kpop (K-POP), natalie-starto (STARTO idols),
  // natalie-drama (日剧/映画).
  if (source.id === "natalie-kpop") return fetchMastodonNatalie(source.id, source.url, 20, K_POP_KEYWORDS);
  if (source.id === "natalie-starto") return fetchMastodonNatalie(source.id, source.url, 20, STARTO_KEYWORDS);
  if (source.id === "natalie-drama") return fetchMastodonNatalie(source.id, source.url, 20, JP_DRAMA_KEYWORDS);
  if (source.id === "theqoo-hot") return fetchTheQoo(source.id, source.url);
  if (source.id === "starto-news") return fetchStartoNews(source.id, source.url);
  if (source.id === "modelpress") return fetchModelpress(source.id, source.url);
  if (source.type === "youtube") return fetchYoutube(source.id, source.url, source.category);
  return fetchRss(source.id, source.url, source.category, {
    useCurl: source.useCurl,
  });
}
