import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SourceDef } from "./types";

export const REPORT_LOCALE: "zh" | "en" =
  process.env.REPORT_LOCALE === "en" ? "en" : "zh";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(__dirname, "../..", "sources.json");

function loadAndValidate(): SourceDef[] {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Source config missing: ${CONFIG_PATH}`);
  }
  let raw: string;
  try {
    raw = fs.readFileSync(CONFIG_PATH, "utf8");
  } catch (e) {
    throw new Error(`Cannot read ${CONFIG_PATH}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in ${CONFIG_PATH}: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${CONFIG_PATH}: top-level must be an array of sources`);
  }

  const validTypes = new Set(["rss", "api", "scrape", "youtube"]);
  const validCategories = new Set(["tech", "finance", "politics", "entertainment"]);
  const seenIds = new Set<string>();

  for (let i = 0; i < parsed.length; i++) {
    const s = parsed[i] as Record<string, unknown>;
    const at = `sources.json[${i}]`;
    if (typeof s.id !== "string" || !s.id) throw new Error(`${at}: missing string 'id'`);
    if (seenIds.has(s.id)) throw new Error(`${at}: duplicate id '${s.id}'`);
    seenIds.add(s.id);
    if (typeof s.name !== "string") throw new Error(`${at} (${s.id}): missing 'name'`);
    if (typeof s.url !== "string") throw new Error(`${at} (${s.id}): missing 'url'`);
    if (!validTypes.has(s.type as string)) {
      throw new Error(`${at} (${s.id}): invalid 'type' '${String(s.type)}'`);
    }
    if (!validCategories.has(s.category as string)) {
      throw new Error(`${at} (${s.id}): invalid 'category' '${String(s.category)}'`);
    }
    if (s.locales !== undefined) {
      if (!Array.isArray(s.locales) || s.locales.some((l) => l !== "zh" && l !== "en")) {
        throw new Error(`${at} (${s.id}): 'locales' must be an array of "zh" | "en"`);
      }
    }
  }
  return parsed as SourceDef[];
}

function filterByLocale(all: SourceDef[]): SourceDef[] {
  return all.filter((s) => {
    const locales = s.locales ?? ["zh", "en"];
    return locales.includes(REPORT_LOCALE);
  });
}

const allValidated = loadAndValidate();
const localeFiltered = filterByLocale(allValidated);

/** All enabled sources (public + private) for the full HTML report. */
export const allSources: SourceDef[] = localeFiltered.filter((s) => s.enabled !== false);

/** Public sources only — backward compatible with existing enrich/render logic. */
export const sources: SourceDef[] = allSources.filter((s) => !s.is_private);

/** Private sources only — feeds Core Feed → Make → Feishu. */
export const privateSources: SourceDef[] = allSources.filter((s) => s.is_private === true);

/** The full unfiltered list for CLI inspection (`npm run sources`). */
export function loadAllSources(): SourceDef[] {
  return loadAndValidate();
}
