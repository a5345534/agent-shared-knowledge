import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharedKnowledgeLifecycle from "../.pi/extensions/shared-knowledge-lifecycle.ts";
import { createCapturedPayload, createReviewResult, KnowledgeJobQueue } from "../src/knowledge-job-runtime.ts";

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("knowledge-review is explicit, local, and stages one confirmed candidate without leaking content", async () => {
  const commands = new Map<string, any>();
  const events = new Map<string, Array<(...args: any[]) => unknown>>();
  const pi = {
    registerCommand(name: string, command: any) { commands.set(name, command); },
    on(name: string, handler: (...args: any[]) => unknown) {
      events.set(name, [...(events.get(name) ?? []), handler]);
    },
  };
  sharedKnowledgeLifecycle(pi as never);
  assert.ok(commands.has("knowledge-review"));

  const root = mkdtempSync(join(tmpdir(), "knowledge-review-extension-"));
  const previousRuntime = process.env.SHARED_KNOWLEDGE_RUNTIME_DIR;
  const previousMaterializer = process.env.SHARED_KNOWLEDGE_MATERIALIZER;
  const previousCommand = process.env.SHARED_KNOWLEDGE_MATERIALIZER_COMMAND;
  const commandMarker = join(root, "command-materializer-ran");
  process.env.SHARED_KNOWLEDGE_RUNTIME_DIR = join(root, "runtime");
  process.env.SHARED_KNOWLEDGE_MATERIALIZER = "command";
  process.env.SHARED_KNOWLEDGE_MATERIALIZER_COMMAND = JSON.stringify([
    process.execPath,
    "-e",
    `require('fs').writeFileSync(${JSON.stringify(commandMarker)}, 'ran')`,
  ]);
  try {
    const workspace = join(root, "workspace");
    const queue = new KnowledgeJobQueue(workspace);
    const privateBody = "private candidate body must never reach a notification";
    const { job } = queue.enqueue(createCapturedPayload(workspace, "review", "durable review source ".repeat(30)));
    queue.update(job.id, {
      state: "review-ready",
      payload: undefined,
      result: createReviewResult([{
        candidate_id: "review-extension-candidate",
        name: "Review extension candidate",
        description: "A candidate retained only for local review.",
        type: "reference",
        suggested_scope: "workspace",
        body: privateBody,
        reason: "It validates review approval isolation.",
        evidence: ["private evidence"],
      }]),
    });

    const notifications: string[] = [];
    const customSteps = ["select-job", "approve"];
    const ctx: any = {
      cwd: workspace,
      mode: "tui",
      hasUI: true,
      sessionManager: { getSessionFile: () => undefined },
      ui: {
        notify: (message: string) => notifications.push(message),
        confirm: async () => true,
        custom: async (factory: any) => new Promise((resolve) => {
          const component = factory({ requestRender() {} }, { fg: (_: string, text: string) => text, bold: (text: string) => text }, {}, resolve);
          const step = customSteps.shift();
          if (step === "select-job") component.handleInput("\r");
          else if (step === "approve") component.handleInput("a");
          else resolve(null);
        }),
        select: async () => undefined,
        setWidget() {}, setStatus() {},
      },
    };

    await commands.get("knowledge-review").handler("", ctx);
    assert.equal(queue.read(job.id)?.state, "done");
    const inbox = join(workspace, "knowledge", "inbox");
    assert.equal(readdirSync(inbox).filter((entry) => entry.endsWith(".md")).length, 1);
    assert.equal(existsSync(join(workspace, "knowledge", "facts")), false, "approval must not absorb or promote");
    assert.equal(existsSync(commandMarker), false, "approval must not spawn the effective command materializer");
    assert.equal(JSON.stringify(notifications).includes(privateBody), false);
    assert.equal(JSON.stringify(notifications).includes("private evidence"), false);

    const nonTui = { ...ctx, mode: "rpc", hasUI: true };
    await commands.get("knowledge-review").handler("", nonTui);
    assert.equal(JSON.stringify(notifications).includes(privateBody), false);
  } finally {
    restoreEnv("SHARED_KNOWLEDGE_RUNTIME_DIR", previousRuntime);
    restoreEnv("SHARED_KNOWLEDGE_MATERIALIZER", previousMaterializer);
    restoreEnv("SHARED_KNOWLEDGE_MATERIALIZER_COMMAND", previousCommand);
  }
});
