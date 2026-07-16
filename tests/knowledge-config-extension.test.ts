import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharedKnowledgeLifecycle from "../.pi/extensions/shared-knowledge-lifecycle.ts";

test("extension registers commands, isolates sessions, completes exact models, and never changes foreground model", async () => {
  const commands = new Map<string, any>();
  const events = new Map<string, Array<(...args: any[]) => unknown>>();
  let foregroundChanges = 0;
  const pi = {
    registerCommand(name: string, command: any) { commands.set(name, command); },
    on(name: string, handler: (...args: any[]) => unknown) {
      events.set(name, [...(events.get(name) ?? []), handler]);
    },
    setModel() { foregroundChanges += 1; },
  };
  sharedKnowledgeLifecycle(pi as never);
  assert.deepEqual([...commands.keys()].sort(), ["knowledge-config", "knowledge-model", "knowledge-status"]);

  const root = mkdtempSync(join(tmpdir(), "knowledge-config-extension-"));
  const oldRuntime = process.env.SHARED_KNOWLEDGE_RUNTIME_DIR;
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  const oldModel = process.env.SHARED_KNOWLEDGE_EXTRACTION_MODEL;
  process.env.SHARED_KNOWLEDGE_RUNTIME_DIR = join(root, "runtime");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  delete process.env.SHARED_KNOWLEDGE_EXTRACTION_MODEL;
  try {
    const models = [
      { provider: "openrouter", id: "anthropic/claude-sonnet-4" },
      { provider: "openai", id: "gpt-test" },
    ];
    const notifications: string[] = [];
    const makeContext = (session: object) => ({
      cwd: join(root, "workspace"),
      mode: "tui",
      hasUI: true,
      sessionManager: { getSessionFile: () => undefined, marker: session },
      model: { provider: "active-provider", id: "active-model" },
      modelRegistry: {
        getAvailable: () => models,
        find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "not-persisted" }),
      },
      ui: {
        notify: (message: string) => notifications.push(message),
        select: async () => undefined,
        confirm: async () => true,
        setWidget() {}, setStatus() {},
      },
      isIdle: () => true,
    });
    const first = makeContext({ first: true });
    const second = makeContext({ second: true });
    for (const handler of events.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, first);

    const completions = commands.get("knowledge-model").getArgumentCompletions("");
    assert.ok(completions.some((item: any) => item.value === "openrouter/anthropic/claude-sonnet-4"));
    await commands.get("knowledge-model").handler("openrouter/anthropic/claude-sonnet-4 --scope session", first);
    await commands.get("knowledge-status").handler("", first);
    assert.match(notifications.at(-1)!, /openrouter\/anthropic\/claude-sonnet-4/);
    assert.match(notifications.at(-1)!, /Source: session/);

    await commands.get("knowledge-status").handler("", second);
    assert.match(notifications.at(-1)!, /active-provider\/active-model/);
    assert.match(notifications.at(-1)!, /Source: active/);
    assert.equal(foregroundChanges, 0);
    assert.equal(JSON.stringify(notifications).includes("not-persisted"), false);

    process.env.SHARED_KNOWLEDGE_EXTRACTION_MODEL = "malformed";
    await commands.get("knowledge-model").handler("active --scope session", first);
    assert.match(notifications.at(-1)!, /--allow-inactive/);
    await commands.get("knowledge-status").handler("", first);
    assert.match(notifications.at(-1)!, /invalid environment value/);
    assert.match(notifications.at(-1)!, /locked by environment/);
  } finally {
    if (oldRuntime === undefined) delete process.env.SHARED_KNOWLEDGE_RUNTIME_DIR; else process.env.SHARED_KNOWLEDGE_RUNTIME_DIR = oldRuntime;
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
    if (oldModel === undefined) delete process.env.SHARED_KNOWLEDGE_EXTRACTION_MODEL; else process.env.SHARED_KNOWLEDGE_EXTRACTION_MODEL = oldModel;
  }
});
