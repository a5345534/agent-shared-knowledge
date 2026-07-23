import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharedKnowledgeLifecycle from "../.pi/extensions/shared-knowledge-lifecycle.ts";
import { createCapturedPayload, KnowledgeJobQueue } from "../src/knowledge-job-runtime.ts";

function saveEnv(name: string): string | undefined {
  return process.env[name];
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("extension configures materializers and recovers jobs without foreground mutation or payload disclosure", async () => {
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
  assert.deepEqual([...commands.keys()].sort(), [
    "knowledge-config", "knowledge-feedback", "knowledge-heat", "knowledge-issue-queue", "knowledge-jobs", "knowledge-materializer", "knowledge-model", "knowledge-publisher", "knowledge-review", "knowledge-status",
  ]);

  const root = mkdtempSync(join(tmpdir(), "knowledge-config-extension-"));
  const previous = Object.fromEntries([
    "SHARED_KNOWLEDGE_RUNTIME_DIR",
    "PI_CODING_AGENT_DIR",
    "SHARED_KNOWLEDGE_EXTRACTION_MODEL",
    "SHARED_KNOWLEDGE_MATERIALIZER",
    "SHARED_KNOWLEDGE_MATERIALIZER_COMMAND",
    "SHARED_KNOWLEDGE_PUBLISHER",
    "SHARED_KNOWLEDGE_ASYNC_EXTRACTION",
  ].map((name) => [name, saveEnv(name)]));
  process.env.SHARED_KNOWLEDGE_RUNTIME_DIR = join(root, "runtime");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  delete process.env.SHARED_KNOWLEDGE_EXTRACTION_MODEL;
  process.env.SHARED_KNOWLEDGE_MATERIALIZER = "command";
  process.env.SHARED_KNOWLEDGE_MATERIALIZER_COMMAND = JSON.stringify([process.execPath, "-e", "process.exit(0)"]);
  delete process.env.SHARED_KNOWLEDGE_PUBLISHER;
  delete process.env.SHARED_KNOWLEDGE_ASYNC_EXTRACTION;

  try {
    const models = [
      { provider: "openrouter", id: "anthropic/claude-sonnet-4" },
      { provider: "openai", id: "gpt-test" },
    ];
    const notifications: string[] = [];
    const selections: Array<string | undefined> = [];
    const confirmations: boolean[] = [];
    const selectionCalls: Array<{ title: string; options: string[] }> = [];
    let idle = false;
    const workspace = join(root, "workspace");
    const queue = new KnowledgeJobQueue(workspace);
    const secret = "private candidate body must never be shown";
    const failed = queue.enqueue(createCapturedPayload(workspace, "other-process", "A durable architecture decision must remain private and deterministic. ".repeat(10))).job;
    queue.update(failed.id, { state: "failed", attempts: 3, error: `Error: Materializer exited 7: ${secret}` });
    const running = queue.enqueue(createCapturedPayload(workspace, "other-running", "A separate durable policy decision must remain private and deterministic. ".repeat(10))).job;
    queue.update(running.id, { state: "running" });

    const session = { marker: "session" };
    const ctx = {
      cwd: workspace,
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
        select: async (title: string, options: string[]) => {
          selectionCalls.push({ title, options });
          return selections.shift();
        },
        confirm: async () => confirmations.shift() ?? true,
        setWidget() {}, setStatus() {},
      },
      isIdle: () => idle,
    };
    for (const handler of events.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);

    await commands.get("knowledge-status").handler("", ctx);
    assert.match(notifications.at(-1)!, /Materializer: command/);
    assert.match(notifications.at(-1)!, /Materializer source: environment/);
    assert.match(notifications.at(-1)!, /Command binding: available/);
    assert.equal(notifications.at(-1)!.includes("process.exit"), false);
    assert.equal(queue.read(running.id)?.state, "running", "passive status must not recover running jobs");

    await commands.get("knowledge-materializer").handler("review --scope workspace", ctx);
    await commands.get("knowledge-status").handler("", ctx);
    assert.match(notifications.at(-1)!, /Materializer: review/);
    assert.match(notifications.at(-1)!, /Materializer source: workspace/);

    selections.push("Change materializer", "session", "inbox");
    confirmations.push(false);
    await commands.get("knowledge-config").handler("", ctx);
    await commands.get("knowledge-status").handler("", ctx);
    assert.match(notifications.at(-1)!, /Materializer source: workspace/, "declined inbox must not change policy");

    delete process.env.SHARED_KNOWLEDGE_MATERIALIZER_COMMAND;
    await commands.get("knowledge-materializer").handler("command --scope session", ctx);
    assert.match(notifications.at(-1)!, /binding is unavailable/);
    process.env.SHARED_KNOWLEDGE_MATERIALIZER_COMMAND = JSON.stringify([process.execPath, "-e", "process.exit(0)"]);
    confirmations.push(true);
    await commands.get("knowledge-materializer").handler("command --scope session", ctx);
    await commands.get("knowledge-status").handler("", ctx);
    assert.match(notifications.at(-1)!, /Materializer: command/);
    assert.match(notifications.at(-1)!, /Materializer source: session/);
    assert.equal(notifications.at(-1)!.includes("process.exit"), false);
    await commands.get("knowledge-materializer").handler("reset --scope session", ctx);

    await commands.get("knowledge-publisher").handler("pr --scope workspace --acknowledge", ctx);
    await commands.get("knowledge-status").handler("", ctx);
    assert.match(notifications.at(-1)!, /Publisher: pr/);
    assert.match(notifications.at(-1)!, /Publisher source: workspace/);
    await commands.get("knowledge-publisher").handler("auto-merge --scope global --acknowledge", ctx);
    assert.match(notifications.at(-1)!, /cannot be configured globally/);

    const jobLabel = () => {
      const current = queue.read(failed.id)!;
      return `${current.id} · failed · attempts=${current.attempts} · created=${current.createdAt} · updated=${current.updatedAt} · model=${current.modelHint ?? "unknown"} · materializer command exited (7) · retryable`;
    };
    selections.push("Retry one failed job (1)", jobLabel());
    confirmations.push(true);
    await commands.get("knowledge-jobs").handler("", ctx);
    assert.equal(queue.read(failed.id)?.state, "pending");
    assert.equal(queue.read(failed.id)?.attempts, 0);
    assert.equal(queue.read(running.id)?.state, "running", "recovery UI must not alter unrelated running job");
    assert.equal(JSON.stringify(notifications).includes(secret), false);
    assert.ok(selectionCalls.some((call) => call.options.includes("Retry all retryable failed jobs (1)")));

    queue.update(failed.id, { state: "failed", attempts: 3, error: `Error: Materializer exited 7: ${secret}` });
    selections.push("Set workspace review mode and retry all (1)");
    confirmations.push(true);
    await commands.get("knowledge-jobs").handler("", ctx);
    assert.equal(queue.read(failed.id)?.state, "pending");
    await commands.get("knowledge-status").handler("", ctx);
    assert.match(notifications.at(-1)!, /Materializer: review/);
    assert.equal(foregroundChanges, 0);
    assert.equal(JSON.stringify(notifications).includes("not-persisted"), false);

    // Let the scheduled worker run with no active model. It may retry the
    // selected job, but must not recover another process's running job.
    queue.update(failed.id, { state: "failed", attempts: 3, error: secret });
    selections.push("Retry one failed job (1)", jobLabel());
    confirmations.push(true);
    const savedModel = ctx.model;
    (ctx as any).model = undefined;
    idle = true;
    await commands.get("knowledge-jobs").handler("", ctx);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(queue.read(running.id)?.state, "running", "scheduled retry must not recover unrelated running job");
    (ctx as any).model = savedModel;
    idle = false;

    const nonUi = { ...ctx, hasUI: false, mode: "print" };
    await commands.get("knowledge-publisher").handler("auto-merge --scope session", nonUi);
    assert.match(notifications.at(-1)!, /requires --acknowledge/);
    await commands.get("knowledge-status").handler("", ctx);
    assert.match(notifications.at(-1)!, /Publisher source: workspace/, "non-TUI publisher authority must remain unchanged without acknowledgement");
    queue.update(failed.id, { state: "failed", attempts: 3, error: secret });
    await commands.get("knowledge-jobs").handler("", nonUi);
    assert.equal(queue.read(failed.id)?.state, "failed", "non-TUI jobs command must not retry");
  } finally {
    for (const [name, value] of Object.entries(previous)) restoreEnv(name, value);
  }
});
