import "./_env";

import fs from "node:fs";
import path from "node:path";

import { allSources, sources, privateSources, REPORT_LOCALE } from "../lib/sources/registry";
import { fetchSource } from "../lib/sources/dispatch";
import {
  generateDailyReport,
  type ArticleInput,
} from "../lib/ai/pipeline";
import { getModelTag } from "../lib/ai/llm";
import {
  enrichFinanceNewsSummaries,
  enrichGithubTrendingSummaries,
} from "../lib/ai/enrich";
import {
  groupRaw,
  isSportsArticle,
  MERGED_SUBGROUP_LIMITS,
  SOURCE_DISPLAY_LIMITS,
  renderHtml,
  renderMarkdown,
} from "../lib/output/render";
import { analyzeWatchlist } from "../lib/trading/runner";
import { fetchCryptoFearGreed } from "../lib/trading/fear-greed";
import { fetchCryptoGlobal } from "../lib/trading/coingecko";
import { generateTradingCommentary } from "../lib/ai/trading-commentary";
import type { TradingSection } from "../lib/ai/pipeline";
import { todayKey } from "../lib/utils";
import { postToMakeWebhook } from "../lib/webhook/send";

const OUTPUT_DIR = "daily_reports";

async function fetchAll(): Promise<ArticleInput[]> {
  const articles: ArticleInput[] = [];
  const enabled = allSources.filter((s) => s.enabled !== false);
  for (const source of enabled) {
    try {
      const items = await fetchSource(source);
      console.log(`  ${source.id.padEnd(20)} ${items.length}`);
      articles.push(...items.map((it) => ({ ...it, source: source.name })));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  ${source.id.padEnd(20)} FAILED — ${msg}`);
    }
  }
  return articles;
}

async function enrichGhTrending(articles: ArticleInput[]): Promise<void> {
  const gh = articles.filter((a) => a.sourceId === "github-trending");
  if (gh.length === 0) return;
  console.log(
    `[daily] enriching ${gh.length} GitHub Trending repos with ${REPORT_LOCALE} summaries…`,
  );
  const t0 = Date.now();
  const summaries = await enrichGithubTrendingSummaries(gh);
  for (const a of gh) {
    const s = summaries.get(a.url);
    if (s) a.summary = s;
  }
  console.log(
    `[daily] enrichment done in ${((Date.now() - t0) / 1000).toFixed(1)}s, matched ${summaries.size}/${gh.length}`,
  );
}

/**
 * finance:news is rendered as a merged time-sorted list (see
 * MERGED_SUBGROUP_LIMITS in render.ts). Enrich exactly the items that
 * will be displayed: take all enabled finance:news articles, sort by
 * publishedAt desc, slice to the merge limit, ask Sonnet for Chinese
 * factual summaries.
 */
async function enrichFinanceNews(articles: ArticleInput[]): Promise<void> {
  await enrichMergedSubgroup(articles, "finance", "news");
}

async function enrichPolitics(articles: ArticleInput[]): Promise<void> {
  await enrichMergedSubgroup(articles, "politics", "world");
}

async function enrichAiNews(articles: ArticleInput[]): Promise<void> {
  await enrichMergedSubgroup(articles, "tech", "ai-news");
}

/**
 * X 热帖 enrichment is different from merged subgroups — we preserve the
 * AttentionVC API's heat-rank order (do NOT sort by date) and cap to the
 * displayed limit (matches SOURCE_DISPLAY_LIMITS["tech:x-viral"]).
 *
 * The Sonnet prompt also differs (XVIRAL_SYSTEM_PROMPT in enrich.ts) — X
 * tweet titles are clickbait, the previewText holds the actual claim.
 */
async function enrichXViral(articles: ArticleInput[]): Promise<void> {
  await enrichMergedSubgroup(articles, "tech", "x-viral");
}

/**
 * Shared implementation for "merged subgroup" enrichment: collect all
 * enabled articles in (category, subcategory), sort by date desc, take
 * the display cap (from MERGED_SUBGROUP_LIMITS), and ask the LLM to
 * summarize them into REPORT_LOCALE in a single batch. Symmetric to the
 * merge logic in render.ts groupRaw, so display and enrichment stay aligned.
 *
 * Sources whose `lang` already matches REPORT_LOCALE are skipped — no
 * point translating English to English (en mode) or Chinese to Chinese
 * (zh mode).
 */
async function enrichMergedSubgroup(
  articles: ArticleInput[],
  category: "tech" | "finance" | "politics" | "entertainment",
  subcategory: string,
): Promise<void> {
  const subSources = allSources.filter(
    (s) =>
      s.category === category &&
      s.subcategory === subcategory &&
      s.enabled !== false,
  );
  const enabledIds = new Set(subSources.map((s) => s.id));
  const sameLocaleIds = new Set(
    subSources.filter((s) => (s.lang ?? "en") === REPORT_LOCALE).map((s) => s.id),
  );
  const limit = MERGED_SUBGROUP_LIMITS[`${category}:${subcategory}`] ?? 12;
  // Top-N respects all enabled sources (so we don't reshape the merged
  // timeline). Enrichment only targets items NOT already in the target
  // language within that slice.
  const top = articles
    .filter((a) => enabledIds.has(a.sourceId))
    .filter((a) => category !== "politics" || !isSportsArticle(a.title))
    .sort(
      (a, b) =>
        (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0),
    )
    .slice(0, limit);
  const toEnrich = top.filter((a) => !sameLocaleIds.has(a.sourceId));
  if (toEnrich.length === 0) return;
  console.log(
    `[daily] enriching ${toEnrich.length}/${top.length} ${category}:${subcategory} items with ${REPORT_LOCALE} summaries…`,
  );
  const t0 = Date.now();
  const summaries = await enrichFinanceNewsSummaries(toEnrich);
  for (const a of toEnrich) {
    const s = summaries.get(a.url);
    if (s) a.summary = s;
  }
  console.log(
    `[daily] enrichment done in ${((Date.now() - t0) / 1000).toFixed(1)}s, matched ${summaries.size}/${toEnrich.length}`,
  );
}

/**
 * Pull daily OHLCV from Yahoo for every ticker in the watchlist, compute
 * indicators + signals, then ask Sonnet for a market overview + a
 * picks-to-watch list. Returns null if no ticker came back.
 */
async function runTrading(): Promise<TradingSection | null> {
  console.log(`[daily] analyzing watchlist + crypto context (Yahoo / alt.me / CoinGecko)…`);
  const t0 = Date.now();
  const [tickers, cryptoFearGreed, cryptoGlobal] = await Promise.all([
    analyzeWatchlist(),
    fetchCryptoFearGreed(),
    fetchCryptoGlobal(),
  ]);
  console.log(
    `[daily] indicators ready in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${tickers.length} tickers` +
      (cryptoFearGreed ? `, F&G ${cryptoFearGreed.value}` : ", F&G ✗") +
      (cryptoGlobal
        ? `, BTC dom ${cryptoGlobal.btcDominance.toFixed(1)}%`
        : ", CG ✗"),
  );
  if (tickers.length === 0) return null;
  console.log(`[daily] generating trading commentary with ${getModelTag()}…`);
  const t1 = Date.now();
  const commentary = await generateTradingCommentary({
    tickers,
    cryptoFearGreed: cryptoFearGreed ?? undefined,
    cryptoGlobal: cryptoGlobal ?? undefined,
  });
  console.log(
    `[daily] trading commentary ready in ${((Date.now() - t1) / 1000).toFixed(1)}s`,
  );
  return {
    ...commentary,
    tickers,
    crypto_fear_greed: cryptoFearGreed ?? undefined,
    crypto_global: cryptoGlobal ?? undefined,
    generated_at: new Date().toISOString(),
  };
}

/**
 * Build the GitHub Pages URL for today's report.
 * In CI, GITHUB_REPOSITORY and GITHUB_SERVER_URL are set by Actions.
 * Locally, set GITHUB_REPOSITORY=irisrightthere/Iris-Nexus-Brief in .env.local.
 */
function buildReportUrl(date: string): string | null {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) return null;
  const [owner, repoName] = repo.split("/");
  return `https://${owner}.github.io/${repoName}/${date}/${date}.html`;
}

/**
 * Build the Core Feed text message sent to Feishu.
 *
 * Selection rules:
 *   技术动态 — first article per L3 source (exclude AI油管/youtube-channels)
 *   市场行情 — trading overview text
 *   时政 — first article (politics:world)
 *   财经 — first article (finance:news)
 *   娱乐观察 — soompi (韩娱), starto-news + modelpress (日娱)
 */
async function pushCoreFeed(
  articles: ArticleInput[],
  date: string,
  trading: TradingSection | null,
): Promise<void> {
  const url = process.env.MAKE_WEBHOOK_URL;
  if (!url) {
    console.log("[core-feed] MAKE_WEBHOOK_URL not set — skipping");
    return;
  }

  const reportUrl = buildReportUrl(date);

  // Helper: best available text for an article
  const bestSummary = (a: ArticleInput) =>
    a.summary ?? a.excerpt?.slice(0, 200) ?? "";

  // Helper: first article from a given source, sorted by date desc
  const firstFromSource = (sourceId: string) => {
    const sorted = articles
      .filter((a) => a.sourceId === sourceId)
      .sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
    return sorted[0];
  };

  // Helper: first article from all enabled sources under a (category, subcategory)
  const firstFromSub = (cat: string, sub: string) => {
    const ids = new Set(
      allSources
        .filter((s) => s.category === cat && s.subcategory === sub && s.enabled !== false)
        .map((s) => s.id),
    );
    const sorted = articles
      .filter((a) => ids.has(a.sourceId))
      .sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
    return sorted[0];
  };

  // Helper: format one article line
  const fmtArticle = (label: string, a: ArticleInput | undefined) => {
    if (!a || !a.title) return "";
    const s = bestSummary(a);
    return `【${label}】${a.title}${s ? `\n中文摘要: ${s}` : ""}`;
  };

  const sections: string[] = [];

  // ── 技术动态 ──
  const techLines: string[] = [];
  const techSubs = [
    { id: "github-trending", label: "GitHub Trending" },
    { id: "tech:x-viral", label: "X 推文", useSub: true as const, cat: "tech" as const },
    { id: "tech:ai-news", label: "AI 媒体", useSub: true as const, cat: "tech" as const },
    { id: "v2ex-hot", label: "V2EX" },
    { id: "linuxdo", label: "LinuxDo" },
    { id: "hackernews", label: "Hacker News" },
    { id: "reddit-stocks", label: "r/stocks" },
  ];
  for (const spec of techSubs) {
    const a = "useSub" in spec ? firstFromSub(spec.cat, spec.id.split(":")[1]) : firstFromSource(spec.id);
    const line = fmtArticle(spec.label, a);
    if (line) techLines.push(line);
  }
  if (techLines.length > 0) {
    sections.push(`📡 技术动态\n${techLines.join("\n")}`);
  }

  // ── 市场行情 ──
  if (trading?.market_overview) {
    sections.push(`📈 市场行情\n${trading.market_overview}`);
  }

  // ── 时政 ──
  const pol = firstFromSub("politics", "world");
  if (pol) {
    const line = fmtArticle(pol.source, pol);
    if (line) sections.push(`🌍 时政\n${line}`);
  }

  // ── 财经 ──
  const fin = firstFromSub("finance", "news");
  if (fin) {
    const line = fmtArticle(fin.source, fin);
    if (line) sections.push(`💹 财经\n${line}`);
  }

  // ── 娱乐观察 ──
  const entLines: string[] = [];
  const soompi = firstFromSource("soompi");
  const sr = firstFromSource("starto-news");
  const mp = firstFromSource("modelpress");
  const sl = fmtArticle("Soompi", soompi);
  const srl = fmtArticle("STARTO", sr);
  const mpl = fmtArticle("Modelpress", mp);
  if (sl) entLines.push(sl);
  if (srl) entLines.push(srl);
  if (mpl) entLines.push(mpl);
  if (entLines.length > 0) {
    sections.push(`🎬 娱乐观察\n${entLines.join("\n")}`);
  }

  const lines: string[] = [];
  lines.push(`📅 iris daily brief ${date}`);
  if (reportUrl) lines.push(`\n🔗 All in one: \n${reportUrl}`);

  if (sections.length > 0) {
    lines.push(`\n🗒️ core info`);
    lines.push(sections.join("\n\n"));
  }

  lines.push(`\n🍀钱从四面八方来, you are the best💰`);

  const text = lines.join("\n");
  console.log(`[core-feed] ${lines.length - 1} lines, ${text.length} chars`);

  // Pre-build the complete Feishu text message body — JSON.stringify
  // handles all escaping so Make just forwards the string as-is.
  const feishuBody = JSON.stringify({
    msg_type: "text",
    content: { text },
  });
  await postToMakeWebhook({ feishu_body: feishuBody });
}

/**
 * YouTube title enrichment: translate video titles per channel into
 * REPORT_LOCALE. All displayed items (up to 5 per channel) are enriched.
 */
async function enrichYoutube(articles: ArticleInput[]): Promise<void> {
  const ytSources = allSources.filter(
    (s) => s.subcategory === "youtube-channels" && s.enabled !== false,
  );
  const ytIds = new Set(ytSources.map((s) => s.id));
  const toEnrich: ArticleInput[] = [];
  for (const sid of ytIds) {
    const items = articles
      .filter((a) => a.sourceId === sid)
      .sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0))
      .slice(0, 5);
    toEnrich.push(...items);
  }
  if (toEnrich.length === 0) return;
  console.log(`[daily] enriching ${toEnrich.length} YouTube titles with ${REPORT_LOCALE} summaries…`);
  const t0 = Date.now();
  const summaries = await enrichFinanceNewsSummaries(toEnrich);
  for (const a of toEnrich) {
    const s = summaries.get(a.url);
    if (s) a.summary = s;
  }
  console.log(
    `[daily] YouTube enrichment done in ${((Date.now() - t0) / 1000).toFixed(1)}s, matched ${summaries.size}/${toEnrich.length}`,
  );
}

async function enrichEntertainment(articles: ArticleInput[]): Promise<void> {
  await enrichMergedSubgroup(articles, "entertainment", "x-viral");
}

/**
 * Per-source enrichment: for subcategories rendered with L3 source tabs
 * (kpop-news, jp-ent-news), enrich up to N per source then batch-summarize.
 * Sources whose `lang` already matches REPORT_LOCALE are skipped.
 */
async function enrichPerSourceSubgroup(
  articles: ArticleInput[],
  category: "tech" | "finance" | "politics" | "entertainment",
  subcategory: string,
): Promise<void> {
  const subSources = allSources.filter(
    (s) =>
      s.category === category &&
      s.subcategory === subcategory &&
      s.enabled !== false,
  );
  const sameLocaleIds = new Set(
    subSources.filter((s) => (s.lang ?? "en") === REPORT_LOCALE).map((s) => s.id),
  );
  const perSourceLimit = SOURCE_DISPLAY_LIMITS[`${category}:${subcategory}`] ?? 20;

  // Group enabled articles by source, take top N per source via date sort
  const toEnrich: ArticleInput[] = [];
  for (const src of subSources) {
    if (sameLocaleIds.has(src.id)) continue;
    const items = articles
      .filter((a) => a.sourceId === src.id)
      .sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0))
      .slice(0, perSourceLimit);
    toEnrich.push(...items);
  }

  if (toEnrich.length === 0) return;
  console.log(
    `[daily] enriching ${toEnrich.length} ${category}:${subcategory} items (per-source, ${REPORT_LOCALE} summaries)…`,
  );
  const t0 = Date.now();
  const summaries = await enrichFinanceNewsSummaries(toEnrich);
  for (const a of toEnrich) {
    const s = summaries.get(a.url);
    if (s) a.summary = s;
  }
  console.log(
    `[daily] enrichment done in ${((Date.now() - t0) / 1000).toFixed(1)}s, matched ${summaries.size}/${toEnrich.length}`,
  );
}

async function main() {
  const date = todayKey();
  console.log(`[daily] ${date} — fetching sources…\n`);
  const articles = await fetchAll();
  console.log(`\n[daily] total articles: ${articles.length}`);
  if (articles.length === 0) {
    throw new Error("no articles fetched — aborting");
  }

  // Enrich GH Trending, finance news, and politics with Chinese summaries.
  await enrichGhTrending(articles);
  await enrichFinanceNews(articles);
  await enrichPolitics(articles);
  await enrichAiNews(articles);
  await enrichXViral(articles);
  await enrichEntertainment(articles);
  await enrichPerSourceSubgroup(articles, "entertainment", "kpop-news");
  await enrichPerSourceSubgroup(articles, "entertainment", "jp-ent-news");
  await enrichYoutube(articles);

  // Trading signals: Yahoo fetch + indicators + commentary. Non-fatal —
  // if it errors, we still ship the news digest.
  let trading: TradingSection | null = null;
  try {
    trading = await runTrading();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[daily] trading section failed: ${msg}`);
  }

  console.log(`[daily] generating digest with ${getModelTag()}…`);
  const t0 = Date.now();
  const { report } = await generateDailyReport(articles);
  if (trading) report.trading = trading;
  console.log(`[daily] digest ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const dateDir = path.join(OUTPUT_DIR, date);
  fs.mkdirSync(dateDir, { recursive: true });
  const base = path.join(dateDir, date);
  const raw = groupRaw(articles, allSources);
  fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2), "utf8");
  // Sidecar with all fetched articles + LLM-attached summary, so
  // scripts/render.ts can rebuild HTML/MD for UI iteration without
  // re-fetching or re-calling the LLM.
  fs.writeFileSync(
    `${base}-articles.json`,
    JSON.stringify({ date, articles }, null, 2),
    "utf8",
  );
  fs.writeFileSync(`${base}.html`, renderHtml(report, raw, date), "utf8");
  if (process.env.OUTPUT_MARKDOWN === "true") {
    fs.writeFileSync(`${base}.md`, renderMarkdown(report, date), "utf8");
    console.log(`[daily] wrote ${base}.{json,html,md,articles.json}`);
  } else {
    console.log(`[daily] wrote ${base}.{json,html,articles.json}`);
  }

  console.log(`[daily] done.`);

  // ── Core Feed: curated selection → POST to Make webhook → Feishu ──
  try {
    await pushCoreFeed(articles, date, trading);
  } catch (e) {
    console.warn(`[daily] Core Feed push failed (non-fatal): ${e instanceof Error ? e.message : e}`);
  }
}

main().catch((e) => {
  console.error(`[daily] FAILED:`, e);
  process.exit(1);
});
