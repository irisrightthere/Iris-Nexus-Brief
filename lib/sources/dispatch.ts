import { fetchAttentionVc } from "./attentionvc";
import { fetchGithubTrending } from "./github-trending";
import { fetchHackerNews } from "./hackernews";
import { fetchLinuxDo } from "./linuxdo";
import { fetchRss } from "./rss";
import { fetchV2ex } from "./v2ex";
import { fetchTheQoo } from "./theqoo";
import { fetchYoutube } from "./youtube";
import { fetchXAccount } from "./x-account";
import type { RawArticle, SourceDef } from "./types";

/**
 * Single dispatcher used by daily.ts, dry-run.ts, and the cron route.
 * Add a new branch here when introducing a non-RSS fetcher.
 */
export async function fetchSource(source: SourceDef): Promise<RawArticle[]> {
  if (source.id === "hackernews") return fetchHackerNews(source.id);
  if (source.id === "github-trending") return fetchGithubTrending(source.id);
  if (source.id === "v2ex-hot") return fetchV2ex(source.id);
  if (source.id === "linuxdo") return fetchLinuxDo(source.id);
  if (source.id === "attentionvc-ai") return fetchAttentionVc(source.id);
  if (source.id === "theqoo-hot") return fetchTheQoo(source.id, source.url);
  if (source.type === "youtube") return fetchYoutube(source.id, source.url, source.category);
  if (source.type === "x-account") {
    const handle = source.handle ?? source.url.split("/").pop() ?? source.id;
    return fetchXAccount(source.id, handle, source.category);
  }
  return fetchRss(source.id, source.url, source.category, {
    useCurl: source.useCurl,
  });
}
