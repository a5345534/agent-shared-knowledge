import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  commandBinding,
  decodeConfig,
  failedJobSummaries,
  formatMaterializerPolicy,
  formatModelPolicy,
  formatSafeJobDiagnostic,
  globalConfigPath,
  materializerArgumentCompletions,
  modelArgumentCompletions,
  parseKnowledgeMaterializerArgs,
  parseKnowledgeModelArgs,
  parseMaterializerPolicy,
  parseModelReference,
  readConfig,
  requireMaterializerConfig,
  requireModelAuthentication,
  resolveEffectiveMaterializer,
  resolveEffectiveModel,
  safeJobDiagnostic,
  selectExtractionModel,
  summarizeQueue,
  updateConfig,
  workspaceConfigPath,
  writeConfig,
} from "../src/knowledge-config-runtime.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "knowledge-config-"));
  return { root, workspace: join(root, "workspace"), runtime: join(root, "runtime"), agent: join(root, "agent") };
}

test("model references preserve every slash after provider", () => {
  const policy = parseModelReference("openrouter/anthropic/claude-sonnet-4");
  assert.deepEqual(policy, { mode: "fixed", provider: "openrouter", modelId: "anthropic/claude-sonnet-4" });
  assert.equal(formatModelPolicy(policy), "openrouter/anthropic/claude-sonnet-4");
  assert.deepEqual(parseModelReference("active"), { mode: "active" });
  for (const invalid of ["", "provider", "/model", "provider/", "bad provider/model", "provider/model id"]) {
    assert.throws(() => parseModelReference(invalid));
  }
});

test("config decoder reads v1 and strictly validates v2 partial policies", () => {
  assert.deepEqual(decodeConfig({ version: 1, extractionModel: { mode: "active" } }), {
    version: 2,
    extractionModel: { mode: "active" },
  });
  assert.deepEqual(decodeConfig({ version: 2, materializer: { mode: "review" } }), {
    version: 2,
    materializer: { mode: "review" },
  });
  assert.deepEqual(decodeConfig({
    version: 2,
    extractionModel: { mode: "fixed", provider: "p", modelId: "m" },
    materializer: { mode: "inbox" },
  }).materializer, { mode: "inbox" });
  assert.throws(() => decodeConfig({ version: 2 }));
  assert.throws(() => decodeConfig({ version: 2, materializer: { mode: "command", argv: ["unsafe"] } }));
  assert.throws(() => decodeConfig({ version: 2, extractionModel: { mode: "active", apiKey: "secret" } }));
  assert.throws(() => decodeConfig({ version: 1, extractionModel: { mode: "fixed", provider: "p/other", modelId: "m" } }));
  assert.throws(() => decodeConfig({ version: 3, materializer: { mode: "review" } }));
});

test("updating a v1 document migrates to v2 and preserves unrelated fields", () => {
  const { root } = fixture();
  const path = join(root, "config.json");
  writeFileSync(path, JSON.stringify({ version: 1, extractionModel: { mode: "fixed", provider: "p", modelId: "one" } }));
  const afterMaterializer = updateConfig(path, { materializer: { mode: "review" } });
  assert.deepEqual(afterMaterializer, {
    version: 2,
    extractionModel: { mode: "fixed", provider: "p", modelId: "one" },
    materializer: { mode: "review" },
  });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), afterMaterializer);
  const afterModelReset = updateConfig(path, { extractionModel: null });
  assert.deepEqual(afterModelReset, { version: 2, materializer: { mode: "review" } });
  assert.deepEqual(readConfig(path).materializer, { mode: "review" });
  assert.equal(updateConfig(path, { materializer: null }), undefined);
  assert.equal(readConfig(path).document, undefined);
});

test("materializer precedence uses scoped Pi policy before legacy fallback", () => {
  const session = { mode: "review" } as const;
  const workspace = { mode: "inbox" } as const;
  const global = { mode: "command" } as const;
  const env = {
    SHARED_KNOWLEDGE_MATERIALIZER: "command",
    SHARED_KNOWLEDGE_MATERIALIZER_COMMAND: JSON.stringify(["node", "worker.js"]),
  };
  assert.equal(resolveEffectiveMaterializer({ env }).source, "environment");
  assert.equal(resolveEffectiveMaterializer({ env, global: { materializer: global } }).source, "global");
  assert.equal(resolveEffectiveMaterializer({ env, workspace: { materializer: workspace }, global: { materializer: global } }).source, "workspace");
  assert.equal(resolveEffectiveMaterializer({ env, session, workspace: { materializer: workspace } }).source, "session");
  const command = resolveEffectiveMaterializer({ env, global: { materializer: global } });
  assert.equal(command.commandBindingAvailable, true);
  assert.deepEqual(requireMaterializerConfig(command), { mode: "command", argv: ["node", "worker.js"] });
  assert.equal(formatMaterializerPolicy({ mode: "inbox" }), "inbox");
  assert.deepEqual(resolveEffectiveMaterializer({ env: {} }).policy, { mode: "review" });
  assert.deepEqual(resolveEffectiveMaterializer({ env: { SHARED_KNOWLEDGE_MATERIALIZER: "   " } }).policy, { mode: "review" });
});

test("invalid command binding and legacy mode fail closed without argv disclosure", () => {
  const missing = resolveEffectiveMaterializer({ env: {}, session: { mode: "command" } });
  assert.equal(missing.commandBindingAvailable, false);
  assert.match(missing.error!, /binding is unavailable/);
  assert.throws(() => requireMaterializerConfig(missing), /binding is unavailable/);
  assert.deepEqual(commandBinding({ SHARED_KNOWLEDGE_MATERIALIZER_COMMAND: "not-json" }), { available: false });
  const invalidLegacy = resolveEffectiveMaterializer({ env: { SHARED_KNOWLEDGE_MATERIALIZER: "unsafe" } });
  assert.equal(invalidLegacy.policy, undefined);
  assert.match(invalidLegacy.error!, /Invalid SHARED_KNOWLEDGE_MATERIALIZER/);
  assert.equal(JSON.stringify(missing).includes("worker.js"), false);
});

test("model precedence and malformed environment lock remain deterministic", () => {
  const active = { mode: "active" } as const;
  const global = { mode: "fixed", provider: "global", modelId: "g" } as const;
  const workspace = { mode: "fixed", provider: "workspace", modelId: "w" } as const;
  const session = { mode: "fixed", provider: "session", modelId: "s" } as const;
  assert.equal(resolveEffectiveModel({ env: {}, global: { policy: global } }).source, "global");
  assert.equal(resolveEffectiveModel({ env: {}, workspace: { policy: workspace }, global: { policy: global } }).source, "workspace");
  assert.equal(resolveEffectiveModel({ env: {}, session, workspace: { policy: workspace } }).source, "session");
  const locked = resolveEffectiveModel({ env: { SHARED_KNOWLEDGE_EXTRACTION_MODEL: "env/org/model" }, session });
  assert.equal(locked.source, "environment");
  assert.equal(locked.locked, true);
  assert.equal(formatModelPolicy(locked.policy!), "env/org/model");
  assert.deepEqual(resolveEffectiveModel({ env: {} }).policy, active);
  const invalid = resolveEffectiveModel({ env: { SHARED_KNOWLEDGE_EXTRACTION_MODEL: "missing-slash" }, session });
  assert.equal(invalid.policy, undefined);
  assert.equal(invalid.locked, true);
  assert.match(invalid.error!, /Invalid SHARED_KNOWLEDGE_EXTRACTION_MODEL/);
});

test("private config paths and writes exclude credentials and argv", () => {
  const { workspace, runtime, agent } = fixture();
  mkdirSync(workspace);
  const workspacePath = workspaceConfigPath(workspace, { SHARED_KNOWLEDGE_RUNTIME_DIR: runtime });
  const globalPath = globalConfigPath(agent);
  assert.ok(workspacePath.startsWith(`${runtime}/workspace-`));
  assert.equal(globalPath, join(agent, "shared-knowledge.json"));
  writeConfig(globalPath, { version: 2, extractionModel: { mode: "fixed", provider: "openai", modelId: "gpt" }, materializer: { mode: "command" } });
  assert.equal(lstatSync(agent).mode & 0o077, 0);
  assert.equal(lstatSync(globalPath).mode & 0o077, 0);
  const raw = readFileSync(globalPath, "utf8");
  assert.equal(raw.includes("apiKey"), false);
  assert.equal(raw.includes("Authorization"), false);
  assert.equal(raw.includes("argv"), false);
  writeConfig(workspacePath, { mode: "active" });
  assert.equal(readConfig(workspacePath).policy?.mode, "active");
});

test("symlink and malformed configs fail closed", () => {
  const { root } = fixture();
  const target = join(root, "target.json");
  const path = join(root, "config.json");
  writeFileSync(target, "untouched");
  symlinkSync(target, path);
  assert.throws(() => updateConfig(path, { materializer: { mode: "review" } }), /symlink/);
  assert.match(readConfig(path).diagnostic!, /symlink/);
  assert.equal(readFileSync(target, "utf8"), "untouched");

  const dangling = join(root, "dangling.json");
  symlinkSync(join(root, "missing-target"), dangling);
  assert.throws(() => updateConfig(dangling, { materializer: { mode: "review" } }), /symlink/);
  const bad = join(root, "bad.json");
  writeFileSync(bad, "{not-json");
  chmodSync(bad, 0o600);
  assert.match(readConfig(bad).diagnostic!, /invalid or unreadable/);
});

test("argument parsing and completion support materializer scopes", () => {
  const model = parseKnowledgeModelArgs("openrouter/org/model --scope workspace --allow-inactive");
  assert.equal(model.scope, "workspace");
  assert.equal(formatModelPolicy(model.policy!), "openrouter/org/model");
  assert.equal(parseKnowledgeModelArgs("reset --scope=global").action, "reset");
  assert.deepEqual(parseKnowledgeMaterializerArgs("review --scope workspace"), {
    action: "set", policy: { mode: "review" }, scope: "workspace",
  });
  assert.equal(parseKnowledgeMaterializerArgs("reset --scope=global").action, "reset");
  assert.throws(() => parseKnowledgeMaterializerArgs("unsafe"));
  assert.throws(() => parseKnowledgeMaterializerArgs("review --allow-inactive"));
  assert.deepEqual(modelArgumentCompletions([{ provider: "openrouter", id: "org/model" }], "open"), ["openrouter/org/model"]);
  assert.deepEqual(materializerArgumentCompletions("in"), ["inbox"]);
  assert.deepEqual(materializerArgumentCompletions("review --scope w"), ["review --scope workspace"]);
  assert.deepEqual(parseMaterializerPolicy("COMMAND"), { mode: "command" });
});

test("credential resolution and attempt-time model selection fail closed", () => {
  assert.deepEqual(requireModelAuthentication({ ok: true, apiKey: "key" }, "p/m"), { apiKey: "key", headers: undefined });
  assert.throws(() => requireModelAuthentication({ ok: false }, "p/m"), /Credentials unavailable/);
  const models = new Map([["p/first", { id: "first" }], ["p/second", { id: "second" }]]);
  const find = (provider: string, id: string) => models.get(`${provider}/${id}`);
  const first = resolveEffectiveModel({ env: {}, workspace: { policy: { mode: "fixed", provider: "p", modelId: "first" } } });
  const retry = resolveEffectiveModel({ env: {}, workspace: { policy: { mode: "fixed", provider: "p", modelId: "second" } } });
  assert.equal(selectExtractionModel(first, undefined, find).id, "first");
  assert.equal(selectExtractionModel(retry, undefined, find).id, "second");
  assert.throws(() => selectExtractionModel(resolveEffectiveModel({ env: {}, session: { mode: "fixed", provider: "p", modelId: "gone" } }), { id: "active" }, find), /unavailable/);
});

test("job summaries allowlist diagnostics and never render raw errors", () => {
  const secret = "private candidate body must never reach recovery UI";
  const command = safeJobDiagnostic(`Error: Materializer exited 17: ${secret}`);
  assert.deepEqual(command, { category: "materializer-command-exited", exitCode: 17 });
  assert.equal(formatSafeJobDiagnostic(command).includes(secret), false);
  const unknown = safeJobDiagnostic(secret);
  assert.deepEqual(unknown, { category: "background-failure" });
  assert.equal(formatSafeJobDiagnostic(unknown).includes(secret), false);
  const summaries = failedJobSummaries([
    { id: "a".repeat(24), state: "failed", attempts: 3, createdAt: "2026-01-01", updatedAt: "2026-01-02", version: 1, payloadHash: "h", error: secret, payload: {} } as never,
    { id: "b".repeat(24), state: "done", attempts: 0, createdAt: "2026-01-01", updatedAt: "2026-01-02", version: 1, payloadHash: "h", error: secret } as never,
    { id: "c".repeat(24), state: "failed", attempts: 3, createdAt: "2026-01-01", updatedAt: "2026-01-02", version: 1, payloadHash: "h" } as never,
  ]);
  assert.equal(summaries.length, 2);
  assert.equal(summaries[0].retryable, true);
  assert.equal(summaries[1].retryable, false);
  assert.equal(JSON.stringify(summaries).includes(secret), false);
});

test("status queue counts exclude payload-shaped values", () => {
  const counts = summarizeQueue([
    { state: "pending", payload: "secret" } as never,
    { state: "retry-wait", result: "candidate" } as never,
    { state: "review-ready", error: "raw" } as never,
    { state: "done" } as never,
  ]);
  assert.deepEqual(counts, { pending: 1, running: 0, "retry-wait": 1, failed: 0, "review-ready": 1 });
  assert.equal(JSON.stringify(counts).includes("secret"), false);
});
