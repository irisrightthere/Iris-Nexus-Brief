/**
 * POST the Core Feed payload to a Make.com webhook for Feishu delivery.
 *
 * Design:
 *   - JSON.stringify() is the primary escape mechanism.
 *   - A secondary pass catches any remaining unescaped control characters
 *     that could trip Feishu's strict JSON parser.
 *   - Non-fatal: failures log a warning and let the daily pipeline finish.
 *   - 15-second timeout + up to 3 retries with exponential backoff.
 */

const TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;

export interface CoreFeedPayload {
  date: string;
  report_url: string;
  core_articles: CoreArticle[];
}

export interface CoreArticle {
  source: string;
  title: string;
  url: string;
  summary: string;
}

/**
 * Double-escape any control characters that could survive JSON.stringify
 * (rare edge case with malformed Unicode / mixed encoding from LLM output).
 */
function sanitizeString(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/\f/g, "\\f")
    .replace(/\b/g, "\\b")
    .replace(/[\x00-\x1f]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function buildBody(payload: CoreFeedPayload): string {
  // JSON.stringify handles the heavy lifting; the per-field sanitize
  // pass catches any LLM-generated stray bytes.
  const safe: CoreFeedPayload = {
    date: payload.date,
    report_url: payload.report_url,
    core_articles: payload.core_articles.map((a) => ({
      source: sanitizeString(a.source),
      title: sanitizeString(a.title),
      url: a.url, // URLs should not contain control chars
      summary: sanitizeString(a.summary),
    })),
  };
  return JSON.stringify(safe);
}

async function postOnce(url: string, body: string, attempt: number): Promise<boolean> {
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (resp.ok) {
      console.log(`[webhook] POST OK (attempt ${attempt}) — status ${resp.status}`);
      return true;
    }

    const text = await resp.text().catch(() => "(no body)");
    console.warn(`[webhook] POST ${resp.status} (attempt ${attempt}): ${text.slice(0, 400)}`);
    return false;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[webhook] POST failed (attempt ${attempt}): ${msg}`);
    return false;
  }
}

export async function postToMakeWebhook(payload: CoreFeedPayload): Promise<void> {
  const url = process.env.MAKE_WEBHOOK_URL;
  if (!url) {
    console.log("[webhook] MAKE_WEBHOOK_URL not set — skipping Core Feed push");
    return;
  }

  const body = buildBody(payload);
  console.log(`[webhook] sending Core Feed (${payload.core_articles.length} articles, ${body.length} bytes)…`);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const ok = await postOnce(url, body, attempt);
    if (ok) return;
    if (attempt < MAX_RETRIES) {
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  console.warn("[webhook] all retries exhausted — Core Feed NOT delivered (pipeline continues)");
}
