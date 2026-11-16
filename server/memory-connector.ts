// Security: one way only. Committed notes go out and nothing is read back, so the bot's local memory stays the only one it reads.
import { cacheUntilConfigChanges } from "./config.ts";
import type { MemoryJournalEntry } from "./memory-journal.ts";
import { isLoopback } from "./provider-key-check.ts";

export type MemoryConnectorKind = "webhook" | "hindsight";

export interface MemoryConnector {
  kind: MemoryConnectorKind;
  url: string;
  token?: string;
  /** Bot id to its Hindsight bank, or to a free label a webhook receives. A bot not listed sends nothing. */
  bots: ReadonlyMap<string, string>;
}

export interface MemoryConnectorRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

const MAX_CONNECTORS = 8;
const MAX_CONTENT = 16_000;
const TIMEOUT_MS = 10_000;
const SENT_BY = new Set<MemoryJournalEntry["actor"]>(["bot", "person"]);
const CUT_DIFF = "\n… (diff cut here)";

/** One bad entry is skipped with a warning; it never fails config.json. */
export function parseMemoryConnectors(raw: unknown, warn: (line: string) => void = console.warn): MemoryConnector[] {
  if (!Array.isArray(raw)) return [];
  const connectors: MemoryConnector[] = [];
  for (const [index, item] of raw.slice(0, MAX_CONNECTORS).entries()) {
    const skip = (reason: string) => warn(`memory-connector: skipping memoryConnectors[${index}]: ${reason}`);
    if (typeof item !== "object" || item === null) { skip("not an object"); continue; }
    // SAFETY: shape probe on parsed JSON; every field used is checked below
    const entry = item as Record<string, unknown>;
    if (entry.kind !== "webhook" && entry.kind !== "hindsight") { skip("kind must be webhook or hindsight"); continue; }
    let url: URL;
    try { url = new URL(String(entry.url ?? "")); } catch { skip("url is not a URL"); continue; }
    if (url.protocol !== "https:" && url.protocol !== "http:") { skip("url must be http or https"); continue; }
    if (url.username || url.password) { skip("put the credential in token, not the url"); continue; }
    const token = typeof entry.token === "string" && entry.token.trim() ? entry.token.trim() : undefined;
    if (token && url.protocol === "http:" && !isLoopback(url.hostname)) { skip("a token is only sent over https or to this computer"); continue; }
    const bots = new Map<string, string>();
    if (typeof entry.bots === "object" && entry.bots !== null && !Array.isArray(entry.bots)) {
      for (const [botId, target] of Object.entries(entry.bots)) {
        if (typeof target === "string" && target.trim()) bots.set(botId, target.trim());
      }
    }
    if (!bots.size) { skip("bots names no bot"); continue; }
    connectors.push({ kind: entry.kind, url: url.href.replace(/\/+$/u, ""), ...(token ? { token } : {}), bots });
  }
  return connectors;
}

/** Security: built from the journal's redacted diff, so text redaction hid never leaves. */
function addedText(diff: string): string {
  return diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n")
    .trim()
    .slice(0, MAX_CONTENT);
}

export function memoryConnectorRequests(entry: MemoryJournalEntry, connectors: readonly MemoryConnector[]): MemoryConnectorRequest[] {
  // Security: the journal redacts after cutting a long diff, so a secret split by the cut can survive; a cut diff is never sent.
  if (!SENT_BY.has(entry.actor) || entry.kind === "deleted" || entry.diff.endsWith(CUT_DIFF)) return [];
  const content = addedText(entry.diff);
  if (!content) return [];
  const at = new Date(entry.at).toISOString();
  const requests: MemoryConnectorRequest[] = [];
  for (const connector of connectors) {
    const target = connector.bots.get(entry.botId);
    if (!target) continue;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (connector.token) headers.authorization = `Bearer ${connector.token}`;
    if (connector.kind === "hindsight") {
      requests.push({
        url: `${connector.url}/v1/default/banks/${encodeURIComponent(target)}/memories`,
        headers,
        body: JSON.stringify({
          items: [{ content, timestamp: at, context: `memory note ${entry.path}`, metadata: { source: "openmausbot", path: entry.path } }],
          async: true,
          operation_id: entry.id,
        }),
      });
    } else {
      requests.push({
        url: connector.url,
        headers,
        body: JSON.stringify({ type: "memory.change", id: entry.id, at, bot: entry.botId, target, path: entry.path, kind: entry.kind, actor: entry.actor, added: content }),
      });
    }
  }
  return requests;
}

const configuredConnectors = cacheUntilConfigChanges((config) => parseMemoryConnectors(config.memoryConnectors));

export function sendMemoryChange(
  entry: MemoryJournalEntry,
  connectors: readonly MemoryConnector[] = configuredConnectors(),
  send: typeof fetch = fetch,
): Promise<void> {
  const requests = memoryConnectorRequests(entry, connectors);
  return Promise.allSettled(requests.map(async (request) => {
    const host = new URL(request.url).host;
    try {
      // Security: a redirect is never followed, so a note only reaches the address in config.json.
      const res = await send(request.url, { method: "POST", headers: request.headers, body: request.body, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
      await res.body?.cancel().catch(() => {});
      if (!res.ok) console.warn(`memory-connector: ${host} answered HTTP ${res.status} for ${entry.botId}`);
    } catch (error) {
      console.warn(`memory-connector: could not reach ${host} for ${entry.botId}: ${error instanceof Error ? error.name : "error"}`);
    }
  })).then(() => undefined);
}
