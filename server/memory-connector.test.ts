import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR, loadConfig, parseConfigPatch, saveConfig } from "./config.ts";
import { memoryConnectorRequests, parseMemoryConnectors, sendMemoryChange, type MemoryConnector } from "./memory-connector.ts";
import { recordMemoryChange, resetMemoryJournalState, type MemoryJournalEntry } from "./memory-journal.ts";

const hindsight: MemoryConnector = { kind: "hindsight", url: "https://memory.example.test", token: "secret-token", bots: new Map([["bot-a", "bank a"]]) };
const webhook: MemoryConnector = { kind: "webhook", url: "https://hooks.example.test/in", bots: new Map([["bot-a", "team-notes"]]) };

function entry(overrides: Partial<MemoryJournalEntry> = {}): MemoryJournalEntry {
  return {
    id: "6f1c0d1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f",
    at: Date.UTC(2026, 0, 2, 3, 4, 5),
    botId: "bot-a",
    path: "MEMORY.md",
    actor: "bot",
    via: "turn",
    kind: "edited",
    beforeHash: "a",
    afterHash: "b",
    before: "- old fact\n",
    diff: "--- a/MEMORY.md\n+++ b/MEMORY.md\n@@ -1 +1,2 @@\n - old fact\n+- Sam prefers tea\n",
    added: 1,
    removed: 0,
    canRevert: true,
    ...overrides,
  };
}

describe("parseMemoryConnectors", () => {
  it("keeps good entries and skips bad ones with a reason, never echoing a token", () => {
    const warnings: string[] = [];
    const parsed = parseMemoryConnectors([
      { kind: "hindsight", url: "https://memory.example.test/", token: "t1", bots: { "bot-a": "bank-a", "bot-b": "" } },
      { kind: "webhook", url: "http://127.0.0.1:9000/hook", token: "t2", bots: { "bot-a": "x" } },
      { kind: "webhook", url: "http://memory.example.test/hook", token: "t3", bots: { "bot-a": "x" } },
      { kind: "mem0", url: "https://memory.example.test", bots: { "bot-a": "x" } },
      { kind: "webhook", url: "https://user:pass@memory.example.test", bots: { "bot-a": "x" } },
      { kind: "webhook", url: "ftp://memory.example.test", bots: { "bot-a": "x" } },
      { kind: "webhook", url: "https://memory.example.test", bots: {} },
      "nope",
    ], (line) => warnings.push(line));
    expect(parsed).toEqual([
      { kind: "hindsight", url: "https://memory.example.test", token: "t1", bots: new Map([["bot-a", "bank-a"]]) },
      { kind: "webhook", url: "http://127.0.0.1:9000/hook", token: "t2", bots: new Map([["bot-a", "x"]]) },
    ]);
    expect(warnings).toHaveLength(6);
    expect(warnings.join("\n")).not.toMatch(/t3|pass/u);
    expect(parseMemoryConnectors(undefined)).toEqual([]);
  });

  it("sends a token over plain http to another computer nowhere, but allows http without one", () => {
    expect(parseMemoryConnectors([{ kind: "hindsight", url: "http://memory.example.test:8888", bots: { "bot-a": "b" } }], () => {})).toHaveLength(1);
  });
});

describe("memoryConnectorRequests", () => {
  it("retains only the added lines in the bot's Hindsight bank, asynchronously and idempotently", () => {
    const [request] = memoryConnectorRequests(entry(), [hindsight]);
    expect(request!.url).toBe("https://memory.example.test/v1/default/banks/bank%20a/memories");
    expect(request!.headers).toEqual({ "content-type": "application/json", authorization: "Bearer secret-token" });
    expect(JSON.parse(request!.body)).toEqual({
      items: [{ content: "- Sam prefers tea", timestamp: "2026-01-02T03:04:05.000Z", context: "memory note MEMORY.md", metadata: { source: "openmausbot", path: "MEMORY.md" } }],
      async: true,
      operation_id: "6f1c0d1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f",
    });
  });

  it("posts a plain change to a webhook with its label", () => {
    const [request] = memoryConnectorRequests(entry(), [webhook]);
    expect(request!.url).toBe("https://hooks.example.test/in");
    expect(request!.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(request!.body)).toMatchObject({ type: "memory.change", bot: "bot-a", target: "team-notes", path: "MEMORY.md", kind: "edited", actor: "bot", added: "- Sam prefers tea" });
  });

  it("sends nothing for an unlisted bot, upkeep, imports, deletions or a change that only removed lines", () => {
    expect(memoryConnectorRequests(entry({ botId: "bot-b" }), [hindsight, webhook])).toEqual([]);
    expect(memoryConnectorRequests(entry({ actor: "upkeep" }), [hindsight])).toEqual([]);
    expect(memoryConnectorRequests(entry({ actor: "import" }), [hindsight])).toEqual([]);
    expect(memoryConnectorRequests(entry({ kind: "deleted" }), [hindsight])).toEqual([]);
    expect(memoryConnectorRequests(entry({ diff: "--- a/MEMORY.md\n+++ b/MEMORY.md\n@@ -1 +0,0 @@\n- old fact\n" }), [hindsight])).toEqual([]);
    expect(memoryConnectorRequests(entry({ actor: "person" }), [hindsight])).toHaveLength(1);
  });
});

describe("sendMemoryChange", () => {
  it("never throws when a service fails or cannot be reached, and logs only the host and status", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("oops secret-token", { status: 500 }))
      .mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(sendMemoryChange(entry(), [hindsight, webhook], send)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
    const logged = warn.mock.calls.flat().join("\n");
    expect(logged).toContain("memory.example.test answered HTTP 500");
    expect(logged).toContain("could not reach hooks.example.test");
    expect(logged).not.toContain("secret-token");
    warn.mockRestore();
  });
});

describe("a committed memory change", () => {
  const configFile = join(DATA_DIR, "config.json");
  let saved: string | null = null;
  afterEach(() => {
    vi.unstubAllGlobals();
    resetMemoryJournalState();
    if (saved === null) rmSync(configFile, { force: true });
    else writeFileSync(configFile, saved);
  });

  it("goes to the bot's configured service from config.json", async () => {
    saved = existsSync(configFile) ? readFileSync(configFile, "utf8") : null;
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(configFile, JSON.stringify({ memoryConnectors: [{ kind: "webhook", url: "https://hooks.example.test/in", bots: { "connector-bot": "notes" } }] }));
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", send);
    recordMemoryChange("connector-bot", { path: "MEMORY.md", actor: "bot", via: "turn", before: "- one\n", after: "- one\n- two\n" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(send.mock.calls[0]![1]!.body))).toMatchObject({ bot: "connector-bot", target: "notes", added: "- two" });
  });

  it("is a config.json field only: a settings save keeps it and the app cannot set it", () => {
    saved = existsSync(configFile) ? readFileSync(configFile, "utf8") : null;
    mkdirSync(DATA_DIR, { recursive: true });
    const connectors = [{ kind: "hindsight", url: "https://memory.example.test", bots: { "bot-a": "bank-a" } }];
    writeFileSync(configFile, JSON.stringify({ memoryConnectors: connectors }));
    saveConfig({ language: "en" });
    expect(loadConfig().memoryConnectors).toEqual(connectors);
    expect(parseConfigPatch({ memoryConnectors: [] })).not.toHaveProperty("memoryConnectors");
  });
});
