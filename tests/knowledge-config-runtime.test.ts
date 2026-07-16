import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  decodeConfig,
  formatModelPolicy,
  globalConfigPath,
  modelArgumentCompletions,
  parseKnowledgeModelArgs,
  parseModelReference,
  readConfig,
  requireModelAuthentication,
  resetConfig,
  resolveEffectiveModel,
  selectExtractionModel,
  summarizeQueue,
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

test("config decoder is versioned and strict", () => {
  assert.deepEqual(decodeConfig({ version: 1, extractionModel: { mode: "active" } }).extractionModel, { mode: "active" });
  assert.throws(() => decodeConfig({ version: 2, extractionModel: { mode: "active" } }));
  assert.throws(() => decodeConfig({ version: 1, extractionModel: { mode: "active", apiKey: "secret" } }));
  assert.throws(() => decodeConfig({ version: 1, extractionModel: { mode: "fixed", provider: "p", modelId: "m", headers: {} } }));
  assert.throws(() => decodeConfig({ version: 1, extractionModel: { mode: "fixed", provider: "p/other", modelId: "m" } }));
});

test("precedence and provenance are deterministic", () => {
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
});

test("malformed environment value remains a fail-closed lock", () => {
  const result = resolveEffectiveModel({
    env: { SHARED_KNOWLEDGE_EXTRACTION_MODEL: "missing-slash" },
    session: { mode: "fixed", provider: "costly", modelId: "fallback" },
  });
  assert.equal(result.source, "environment");
  assert.equal(result.locked, true);
  assert.equal(result.policy, undefined);
  assert.match(result.error!, /Invalid SHARED_KNOWLEDGE_EXTRACTION_MODEL/);
  assert.throws(() => selectExtractionModel(result, { id: "active" }, () => ({ id: "fallback" })), /Invalid/);
});

test("workspace and global config paths and resets are isolated", () => {
  const { workspace, runtime, agent } = fixture();
  mkdirSync(workspace);
  const workspacePath = workspaceConfigPath(workspace, { SHARED_KNOWLEDGE_RUNTIME_DIR: runtime });
  const globalPath = globalConfigPath(agent);
  assert.ok(workspacePath.startsWith(`${runtime}/workspace-`));
  assert.equal(workspacePath.endsWith("/config.json"), true);
  assert.equal(globalPath, join(agent, "shared-knowledge.json"));
  writeConfig(workspacePath, { mode: "fixed", provider: "p", modelId: "m" });
  writeConfig(globalPath, { mode: "active" });
  assert.equal(readConfig(workspacePath).policy?.mode, "fixed");
  resetConfig(workspacePath);
  assert.equal(readConfig(workspacePath).policy, undefined);
  assert.equal(readConfig(globalPath).policy?.mode, "active");
});

test("atomic config is private and contains no credential material", () => {
  const { agent } = fixture();
  const path = globalConfigPath(agent);
  writeConfig(path, { mode: "fixed", provider: "openai", modelId: "gpt" });
  assert.equal(lstatSync(agent).mode & 0o077, 0);
  assert.equal(lstatSync(path).mode & 0o077, 0);
  const raw = readFileSync(path, "utf8");
  assert.equal(raw.includes("apiKey"), false);
  assert.equal(raw.includes("Authorization"), false);
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ["extractionModel", "version"]);
});

test("symlink config targets fail closed including dangling links", () => {
  const { root } = fixture();
  const target = join(root, "target.json");
  const path = join(root, "config.json");
  writeFileSync(target, "untouched");
  symlinkSync(target, path);
  assert.throws(() => writeConfig(path, { mode: "active" }), /symlink/);
  assert.throws(() => resetConfig(path), /symlink/);
  assert.match(readConfig(path).diagnostic!, /symlink/);
  assert.equal(readFileSync(target, "utf8"), "untouched");

  const dangling = join(root, "dangling.json");
  symlinkSync(join(root, "missing-target"), dangling);
  assert.throws(() => writeConfig(dangling, { mode: "active" }), /symlink/);
  assert.throws(() => resetConfig(dangling), /symlink/);
  assert.match(readConfig(dangling).diagnostic!, /symlink/);
});

test("malformed files yield bounded diagnostics and lower precedence", () => {
  const { root } = fixture();
  const path = join(root, "bad.json");
  writeFileSync(path, "{not-json");
  chmodSync(path, 0o600);
  const bad = readConfig(path);
  assert.ok(bad.diagnostic && bad.diagnostic.length < 400);
  const result = resolveEffectiveModel({ env: {}, workspace: bad, global: { policy: { mode: "active" } } });
  assert.equal(result.source, "global");
  assert.equal(result.diagnostics.length, 1);
});

test("argument parsing covers scopes reset lock opt-in and completion", () => {
  const parsed = parseKnowledgeModelArgs("openrouter/org/model --scope workspace --allow-inactive");
  assert.equal(parsed.scope, "workspace");
  assert.equal(parsed.allowInactive, true);
  assert.equal(formatModelPolicy(parsed.policy!), "openrouter/org/model");
  assert.equal(parseKnowledgeModelArgs("reset --scope=global").action, "reset");
  assert.throws(() => parseKnowledgeModelArgs("active --unknown"));
  assert.throws(() => parseKnowledgeModelArgs("active extra"));
  assert.deepEqual(modelArgumentCompletions([{ provider: "openrouter", id: "org/model" }], "open"), ["openrouter/org/model"]);
  assert.deepEqual(modelArgumentCompletions([], "active --scope w"), ["active --scope workspace"]);
  assert.ok(modelArgumentCompletions([], "active ").includes("active --scope session"));
});

test("credential resolution fails closed and never returns absent auth", () => {
  assert.deepEqual(requireModelAuthentication({ ok: true, apiKey: "key" }, "p/m"), { apiKey: "key", headers: undefined });
  assert.deepEqual(requireModelAuthentication({ ok: true, headers: { Authorization: "token" } }, "p/m"), { apiKey: undefined, headers: { Authorization: "token" } });
  assert.throws(() => requireModelAuthentication({ ok: false }, "p/m"), /Credentials unavailable for p\/m/);
  assert.throws(() => requireModelAuthentication({ ok: true }, "p/m"), /Credentials unavailable for p\/m/);
});

test("attempt-time selection sees policy changes and fails closed when unavailable", () => {
  const models = new Map([["p/first", { id: "first" }], ["p/second", { id: "second" }]]);
  const find = (provider: string, id: string) => models.get(`${provider}/${id}`);
  const first = resolveEffectiveModel({ env: {}, workspace: { policy: { mode: "fixed", provider: "p", modelId: "first" } } });
  const retry = resolveEffectiveModel({ env: {}, workspace: { policy: { mode: "fixed", provider: "p", modelId: "second" } } });
  assert.equal(selectExtractionModel(first, undefined, find).id, "first");
  assert.equal(selectExtractionModel(retry, undefined, find).id, "second");
  assert.throws(
    () => selectExtractionModel(resolveEffectiveModel({ env: {}, session: { mode: "fixed", provider: "p", modelId: "gone" } }), { id: "active" }, find),
    /unavailable: p\/gone/,
  );
});

test("status queue summary excludes payload-shaped values", () => {
  const counts = summarizeQueue([
    { state: "pending", payload: "secret" } as never,
    { state: "retry-wait", result: "candidate" } as never,
    { state: "review-ready", error: "raw" } as never,
    { state: "done" } as never,
  ]);
  assert.deepEqual(counts, { pending: 1, running: 0, "retry-wait": 1, failed: 0, "review-ready": 1 });
  assert.equal(JSON.stringify(counts).includes("secret"), false);
});
