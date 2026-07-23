import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharedKnowledgeLifecycle from "../.pi/extensions/shared-knowledge-lifecycle.ts";

test("knowledge-heat is registered and non-TUI output stays aggregate", async () => {
  const commands = new Map<string, any>();
  const pi = {
    registerCommand(name: string, command: any) { commands.set(name, command); },
    on() {},
  };
  sharedKnowledgeLifecycle(pi as never);
  assert.ok(commands.has("knowledge-heat"));

  const root = mkdtempSync(join(tmpdir(), "knowledge-heat-ext-"));
  const previous = process.env.SHARED_KNOWLEDGE_RUNTIME_DIR;
  process.env.SHARED_KNOWLEDGE_RUNTIME_DIR = join(root, "runtime");
  try {
    const notifications: string[] = [];
    const ctx: any = {
      cwd: join(root, "workspace"),
      mode: "print",
      hasUI: false,
      sessionManager: { getSessionFile: () => undefined },
      ui: { notify: (message: string) => notifications.push(message) },
    };
    await commands.get("knowledge-heat").handler("", ctx);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0]!, /events=\d+/);
    assert.match(notifications[0]!, /local TUI/i);
    assert.equal(notifications[0]!.includes("knowledge/facts"), false);
  } finally {
    if (previous === undefined) delete process.env.SHARED_KNOWLEDGE_RUNTIME_DIR;
    else process.env.SHARED_KNOWLEDGE_RUNTIME_DIR = previous;
  }
});
