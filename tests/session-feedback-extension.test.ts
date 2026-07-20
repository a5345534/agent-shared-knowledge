import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharedKnowledgeLifecycle from "../.pi/extensions/shared-knowledge-lifecycle.ts";
import { defaultFeedbackProvenance, SessionFeedbackStore } from "../src/session-feedback-runtime.ts";

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("feedback commands are registered and non-TUI output stays aggregate without mutating state", async () => {
  const commands = new Map<string, any>();
  const events = new Map<string, Array<(...args: any[]) => unknown>>();
  const pi = {
    registerCommand(name: string, command: any) { commands.set(name, command); },
    on(name: string, handler: (...args: any[]) => unknown) { events.set(name, [...(events.get(name) ?? []), handler]); },
  };
  sharedKnowledgeLifecycle(pi as never);
  assert.ok(commands.has("knowledge-feedback"));
  assert.ok(commands.has("knowledge-issue-queue"));

  const root = mkdtempSync(join(tmpdir(), "session-feedback-extension-"));
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
    await commands.get("knowledge-feedback").handler("", ctx);
    await commands.get("knowledge-issue-queue").handler("", ctx);
    assert.equal(notifications.length, 2);
    assert.ok(notifications.every((message) => message.includes("findings=0")));
    assert.equal(JSON.stringify(notifications).includes("private session body"), false);
    assert.equal(existsSync(join(root, "runtime")), false, "passive non-TUI views must not create private feedback state");
  } finally {
    restoreEnv("SHARED_KNOWLEDGE_RUNTIME_DIR", previous);
  }
});

test("feedback TUI groups session findings and explains tracking corroboration after selection", async () => {
  const commands = new Map<string, any>();
  const events = new Map<string, Array<(...args: any[]) => unknown>>();
  const pi = {
    registerCommand(name: string, command: any) { commands.set(name, command); },
    on(name: string, handler: (...args: any[]) => unknown) { events.set(name, [...(events.get(name) ?? []), handler]); },
  };
  sharedKnowledgeLifecycle(pi as never);
  const root = mkdtempSync(join(tmpdir(), "session-feedback-tui-"));
  const previous = process.env.SHARED_KNOWLEDGE_RUNTIME_DIR;
  process.env.SHARED_KNOWLEDGE_RUNTIME_DIR = join(root, "runtime");
  try {
    const cwd = join(root, "workspace");
    const sessionSource = "/private/session.jsonl";
    const store = new SessionFeedbackStore(cwd, {
      provenance: defaultFeedbackProvenance("https://github.com/a5345534/agent-shared-knowledge.git"),
    });
    store.ingest(sessionSource, [{
      classification: "documentation-gap",
      component_kind: "extension",
      component_id: "shared-knowledge-lifecycle",
      user_goal: "complete a documented lifecycle",
      expected: "the lifecycle explains the required steps",
      observed: "the lifecycle omits a required local step",
      workaround: "perform a bounded local workaround",
      normalized_goal: "complete documented lifecycle",
      normalized_gap: "lifecycle omits local step",
      normalized_outcome: "bounded local workaround",
    }]);
    const editors: string[] = [];
    const ctx: any = {
      cwd,
      mode: "tui",
      hasUI: true,
      sessionManager: { getSessionFile: () => sessionSource },
      ui: {
        notify() {},
        async select(title: string, options: string[]) {
          return title === "Session feedback report" ? options[0] : "View private detail";
        },
        async editor(_title: string, value: string) { editors.push(value); return value; },
      },
    };
    await commands.get("knowledge-feedback").handler("", ctx);
    assert.equal(editors.length, 1);
    assert.match(editors[0]!, /Report group: Upstream tracking or ready candidate/);
    assert.match(editors[0]!, /Cluster state: tracking/);
    assert.match(editors[0]!, /1 additional independent session observation\(s\) required/);
  } finally {
    restoreEnv("SHARED_KNOWLEDGE_RUNTIME_DIR", previous);
  }
});

test("pre-compaction feedback path remains capture-only when async extraction is disabled", async () => {
  const commands = new Map<string, any>();
  const events = new Map<string, Array<(...args: any[]) => unknown>>();
  const pi = {
    registerCommand(name: string, command: any) { commands.set(name, command); },
    on(name: string, handler: (...args: any[]) => unknown) { events.set(name, [...(events.get(name) ?? []), handler]); },
  };
  sharedKnowledgeLifecycle(pi as never);
  const previous = process.env.SHARED_KNOWLEDGE_ASYNC_EXTRACTION;
  process.env.SHARED_KNOWLEDGE_ASYNC_EXTRACTION = "0";
  try {
    const ctx: any = {
      cwd: mkdtempSync(join(tmpdir(), "session-feedback-capture-")),
      sessionManager: { getSessionFile: () => undefined },
      ui: { setWidget() {}, notify() {} },
    };
    for (const handler of events.get("session_before_compact") ?? []) {
      await handler({ preparation: { messagesToSummarize: [{ role: "user", content: "private session content" }] } }, ctx);
    }
    assert.ok(commands.has("knowledge-feedback"));
  } finally {
    restoreEnv("SHARED_KNOWLEDGE_ASYNC_EXTRACTION", previous);
  }
});
