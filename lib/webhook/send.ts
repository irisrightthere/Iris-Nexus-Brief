/**
 * POST the Core Feed payload to a Make.com webhook for Feishu delivery.
 *
 * Sends date + report_url + a pre-formatted `text` field. Make extracts
 * {{1.text}} and wraps it into Feishu's text message format.
 *
 * Non-fatal: failures log a warning and let the daily pipeline finish.
 */

const TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;

export interface CoreFeedPayload {
  date: string;
  report_url: string;
  text: string;
}

async function postOnce(url: string, body: string, attempt: number): Promise<boolean> {
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
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

  const body = JSON.stringify({
    date: payload.date,
    report_url: payload.report_url,
    text: payload.text,
  });

  console.log(`[webhook] sending Core Feed (${body.length} bytes)…`);

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
