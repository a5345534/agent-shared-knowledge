import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { KnowledgeJob, JobState } from "./knowledge-job-runtime.ts";
import { resolveRuntimeRoot } from "./knowledge-job-runtime.ts";

export const KNOWLEDGE_CONFIG_VERSION = 2;
export const EXTRACTION_MODEL_ENV = "SHARED_KNOWLEDGE_EXTRACTION_MODEL";
export const MATERIALIZER_ENV = "SHARED_KNOWLEDGE_MATERIALIZER";
export const MATERIALIZER_COMMAND_ENV = "SHARED_KNOWLEDGE_MATERIALIZER_COMMAND";

export type ConfigScope = "session" | "workspace" | "global";
export type ModelPolicy =
  | { mode: "active" }
  | { mode: "fixed"; provider: string; modelId: string };
export type MaterializerMode = "review" | "inbox" | "command";
export type MaterializerPolicy = { mode: MaterializerMode };
export type MaterializerConfig =
  | { mode: "review" }
  | { mode: "inbox" }
  | { mode: "command"; argv: string[] };
export type ConfigDocument = {
  version: typeof KNOWLEDGE_CONFIG_VERSION;
  extractionModel?: ModelPolicy;
  materializer?: MaterializerPolicy;
};
export type ConfigPatch = {
  extractionModel?: ModelPolicy | null;
  materializer?: MaterializerPolicy | null;
};
export type EffectiveModelPolicy = {
  policy?: ModelPolicy;
  source: "environment" | ConfigScope | "active";
  locked: boolean;
  error?: string;
  diagnostics: string[];
};
export type EffectiveMaterializerPolicy = {
  policy?: MaterializerPolicy;
  source: "environment" | ConfigScope | "default";
  commandBindingAvailable: boolean;
  error?: string;
  diagnostics: string[];
  commandArgv?: string[];
};

const PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MODEL_RE = /^\S{1,240}$/;
const ALLOWED_V1_DOCUMENT_KEYS = new Set(["version", "extractionModel"]);
const ALLOWED_V2_DOCUMENT_KEYS = new Set(["version", "extractionModel", "materializer"]);
const ALLOWED_ACTIVE_KEYS = new Set(["mode"]);
const ALLOWED_FIXED_KEYS = new Set(["mode", "provider", "modelId"]);
const ALLOWED_MATERIALIZER_KEYS = new Set(["mode"]);
const MATERIALIZER_MODES = new Set<MaterializerMode>(["review", "inbox", "command"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isModelPolicy(value: ConfigDocument | ModelPolicy): value is ModelPolicy {
  return "mode" in value;
}

export function parseModelReference(value: string): ModelPolicy {
  const normalized = value.trim();
  if (normalized === "active") return { mode: "active" };
  const slash = normalized.indexOf("/");
  if (slash <= 0 || slash === normalized.length - 1) {
    throw new Error("model must be 'active' or an exact provider/model-id reference");
  }
  const provider = normalized.slice(0, slash);
  const modelId = normalized.slice(slash + 1);
  if (!PROVIDER_RE.test(provider) || !MODEL_RE.test(modelId)) {
    throw new Error("model provider or id is invalid");
  }
  return { mode: "fixed", provider, modelId };
}

export function parseEnvironmentModelReference(value: string): ModelPolicy {
  const policy = parseModelReference(value);
  if (policy.mode !== "fixed") throw new Error("environment override must be an exact provider/model-id reference");
  return policy;
}

export function parseMaterializerPolicy(value: string): MaterializerPolicy {
  const mode = value.trim().toLowerCase() as MaterializerMode;
  if (!MATERIALIZER_MODES.has(mode)) throw new Error("materializer must be review, inbox, or command");
  return { mode };
}

export function formatModelPolicy(policy: ModelPolicy): string {
  return policy.mode === "active" ? "active" : `${policy.provider}/${policy.modelId}`;
}

export function formatMaterializerPolicy(policy: MaterializerPolicy): string {
  return policy.mode;
}

function decodeModelPolicy(value: unknown): ModelPolicy {
  if (!isRecord(value) || typeof value.mode !== "string") throw new Error("missing extraction model policy");
  if (value.mode === "active" && hasOnlyKeys(value, ALLOWED_ACTIVE_KEYS)) return { mode: "active" };
  if (
    value.mode === "fixed"
    && hasOnlyKeys(value, ALLOWED_FIXED_KEYS)
    && typeof value.provider === "string"
    && typeof value.modelId === "string"
  ) {
    const parsed = parseModelReference(`${value.provider}/${value.modelId}`);
    if (parsed.mode !== "fixed" || parsed.provider !== value.provider || parsed.modelId !== value.modelId) {
      throw new Error("fixed model policy is invalid");
    }
    return parsed;
  }
  throw new Error("invalid extraction model policy");
}

function decodeMaterializerPolicy(value: unknown): MaterializerPolicy {
  if (!isRecord(value) || !hasOnlyKeys(value, ALLOWED_MATERIALIZER_KEYS) || typeof value.mode !== "string") {
    throw new Error("invalid materializer policy");
  }
  return parseMaterializerPolicy(value.mode);
}

/** Reads legacy v1 model-only config and canonical v2 partial config. */
export function decodeConfig(value: unknown): ConfigDocument {
  if (!isRecord(value) || typeof value.version !== "number") throw new Error("unsupported or malformed config document");
  if (value.version === 1) {
    if (!hasOnlyKeys(value, ALLOWED_V1_DOCUMENT_KEYS)) throw new Error("unsupported or malformed config document");
    return { version: 2, extractionModel: decodeModelPolicy(value.extractionModel) };
  }
  if (value.version !== KNOWLEDGE_CONFIG_VERSION || !hasOnlyKeys(value, ALLOWED_V2_DOCUMENT_KEYS)) {
    throw new Error("unsupported or malformed config document");
  }
  const document: ConfigDocument = { version: 2 };
  if ("extractionModel" in value) document.extractionModel = decodeModelPolicy(value.extractionModel);
  if ("materializer" in value) document.materializer = decodeMaterializerPolicy(value.materializer);
  if (!document.extractionModel && !document.materializer) throw new Error("config document has no policy");
  return document;
}

export type ReadConfigResult = {
  document?: ConfigDocument;
  /** Backward-compatible extraction model alias. */
  policy?: ModelPolicy;
  materializer?: MaterializerPolicy;
  diagnostic?: string;
};

function pathInfo(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function readConfig(path: string): ReadConfigResult {
  try {
    const info = pathInfo(path);
    if (!info) return {};
    if (info.isSymbolicLink()) return { diagnostic: `config path is a symlink: ${path}` };
    if (!info.isFile()) return { diagnostic: `config path is not a regular file: ${path}` };
    if (info.size > 16_384) return { diagnostic: `config file is too large: ${path}` };
    const document = decodeConfig(JSON.parse(readFileSync(path, "utf8")));
    return { document, policy: document.extractionModel, materializer: document.materializer };
  } catch {
    return { diagnostic: `invalid or unreadable config at ${path}` };
  }
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function writeDocument(path: string, document: ConfigDocument): void {
  ensurePrivateDirectory(dirname(path));
  if (pathInfo(path)?.isSymbolicLink()) throw new Error(`refusing symlink config: ${path}`);
  const temp = join(dirname(path), `.${process.pid}-${randomUUID()}-shared-knowledge.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
    chmodSync(path, 0o600);
  } finally {
    if (existsSync(temp)) rmSync(temp, { force: true });
  }
}

/** Writes a full v2 document; ModelPolicy input remains supported for callers from v1 API. */
export function writeConfig(path: string, value: ConfigDocument | ModelPolicy): void {
  const document = isModelPolicy(value)
    ? { version: 2 as const, extractionModel: value }
    : decodeConfig(value);
  writeDocument(path, document);
}

/** Atomically merges/removes one or both policy fields without losing the other field. */
export function updateConfig(path: string, patch: ConfigPatch): ConfigDocument | undefined {
  const current = readConfig(path);
  if (current.diagnostic) throw new Error(current.diagnostic);
  const document: ConfigDocument = { ...(current.document ?? { version: 2 }) };
  if ("extractionModel" in patch) {
    if (patch.extractionModel) document.extractionModel = patch.extractionModel;
    else delete document.extractionModel;
  }
  if ("materializer" in patch) {
    if (patch.materializer) document.materializer = patch.materializer;
    else delete document.materializer;
  }
  if (!document.extractionModel && !document.materializer) {
    resetConfig(path);
    return undefined;
  }
  const normalized = decodeConfig(document);
  writeDocument(path, normalized);
  return normalized;
}

export function resetConfig(path: string): void {
  const info = pathInfo(path);
  if (!info) return;
  if (info.isSymbolicLink()) throw new Error(`refusing symlink config: ${path}`);
  rmSync(path);
}

export function workspaceConfigPath(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveRuntimeRoot(cwd, env), "config.json");
}

export function globalConfigPath(agentDir: string): string {
  return join(agentDir, "shared-knowledge.json");
}

export function resolveEffectiveModel({
  env = process.env,
  session,
  workspace,
  global,
}: {
  env?: NodeJS.ProcessEnv;
  session?: ModelPolicy;
  workspace?: ReadConfigResult;
  global?: ReadConfigResult;
}): EffectiveModelPolicy {
  const diagnostics = [workspace?.diagnostic, global?.diagnostic].filter((value): value is string => Boolean(value));
  const rawEnvironment = env[EXTRACTION_MODEL_ENV];
  if (rawEnvironment !== undefined && rawEnvironment.trim() !== "") {
    try {
      return { policy: parseEnvironmentModelReference(rawEnvironment), source: "environment", locked: true, diagnostics };
    } catch (error) {
      return {
        source: "environment",
        locked: true,
        error: `Invalid ${EXTRACTION_MODEL_ENV}: ${String(error)}`,
        diagnostics,
      };
    }
  }
  if (session) return { policy: session, source: "session", locked: false, diagnostics };
  if (workspace?.policy) return { policy: workspace.policy, source: "workspace", locked: false, diagnostics };
  if (global?.policy) return { policy: global.policy, source: "global", locked: false, diagnostics };
  return { policy: { mode: "active" }, source: "active", locked: false, diagnostics };
}

export type CommandBinding = { available: true; argv: string[] } | { available: false };

export function commandBinding(env: NodeJS.ProcessEnv = process.env): CommandBinding {
  const raw = env[MATERIALIZER_COMMAND_ENV];
  if (!raw || Buffer.byteLength(raw) > 16_384) return { available: false };
  try {
    const argv = JSON.parse(raw) as unknown;
    if (
      !Array.isArray(argv)
      || argv.length === 0
      || argv.length > 64
      || argv.some((item) => typeof item !== "string" || !item || item.length > 4096)
    ) return { available: false };
    return { available: true, argv: [...argv] };
  } catch {
    return { available: false };
  }
}

function legacyMaterializer(env: NodeJS.ProcessEnv): { policy?: MaterializerPolicy; error?: string } {
  const raw = env[MATERIALIZER_ENV];
  if (raw === undefined) return {};
  try {
    return { policy: parseMaterializerPolicy(raw.trim() || "review") };
  } catch {
    return { error: `Invalid ${MATERIALIZER_ENV}` };
  }
}

export function resolveEffectiveMaterializer({
  env = process.env,
  session,
  workspace,
  global,
}: {
  env?: NodeJS.ProcessEnv;
  session?: MaterializerPolicy;
  workspace?: ReadConfigResult;
  global?: ReadConfigResult;
}): EffectiveMaterializerPolicy {
  const diagnostics = [workspace?.diagnostic, global?.diagnostic].filter((value): value is string => Boolean(value));
  const selected = session
    ? { policy: session, source: "session" as const }
    : workspace?.materializer
      ? { policy: workspace.materializer, source: "workspace" as const }
      : global?.materializer
        ? { policy: global.materializer, source: "global" as const }
        : undefined;
  const legacy = legacyMaterializer(env);
  const resolved = selected ?? (legacy.policy ? { policy: legacy.policy, source: "environment" as const } : undefined);
  if (!resolved) {
    if (legacy.error) return { source: "environment", commandBindingAvailable: false, error: legacy.error, diagnostics };
    return { policy: { mode: "review" }, source: "default", commandBindingAvailable: false, diagnostics };
  }
  if (resolved.policy.mode !== "command") {
    return { policy: resolved.policy, source: resolved.source, commandBindingAvailable: false, diagnostics };
  }
  const binding = commandBinding(env);
  if (!binding.available) {
    return {
      policy: resolved.policy,
      source: resolved.source,
      commandBindingAvailable: false,
      error: "Configured command materializer binding is unavailable",
      diagnostics,
    };
  }
  return {
    policy: resolved.policy,
    source: resolved.source,
    commandBindingAvailable: true,
    commandArgv: binding.argv,
    diagnostics,
  };
}

export function requireMaterializerConfig(effective: EffectiveMaterializerPolicy): MaterializerConfig {
  if (effective.error || !effective.policy) throw new Error(effective.error ?? "No materializer policy available");
  if (effective.policy.mode === "command") {
    if (!effective.commandArgv) throw new Error("Configured command materializer binding is unavailable");
    return { mode: "command", argv: effective.commandArgv };
  }
  if (effective.policy.mode === "inbox") return { mode: "inbox" };
  return { mode: "review" };
}

/** Legacy environment-only parser retained for package consumers and tests. */
export function parseMaterializerConfig(env: NodeJS.ProcessEnv = process.env): MaterializerConfig {
  const effective = resolveEffectiveMaterializer({ env });
  return requireMaterializerConfig(effective);
}

export function requireModelAuthentication(
  auth: { ok: boolean; apiKey?: string; headers?: Record<string, string> },
  modelIdentity: string,
): { apiKey?: string; headers?: Record<string, string> } {
  if (!auth.ok || (!auth.apiKey && Object.keys(auth.headers ?? {}).length === 0)) {
    throw new Error(`Credentials unavailable for ${modelIdentity}`);
  }
  return { apiKey: auth.apiKey, headers: auth.headers };
}

export function selectExtractionModel<T>(
  effective: EffectiveModelPolicy,
  activeModel: T | undefined,
  find: (provider: string, modelId: string) => T | undefined,
): T {
  if (effective.error || !effective.policy) throw new Error(effective.error ?? "No extraction model policy available");
  if (effective.policy.mode === "active") {
    if (!activeModel) throw new Error("No active model available");
    return activeModel;
  }
  const model = find(effective.policy.provider, effective.policy.modelId);
  if (!model) throw new Error(`Configured extraction model is unavailable: ${formatModelPolicy(effective.policy)}`);
  return model;
}

export type KnowledgeModelArgs = {
  action?: "set" | "reset";
  policy?: ModelPolicy;
  scope: ConfigScope;
  allowInactive: boolean;
};

export type KnowledgeMaterializerArgs = {
  action?: "set" | "reset";
  policy?: MaterializerPolicy;
  scope: ConfigScope;
};

function parseScopeOptions(raw: string): { value?: string; scope: ConfigScope; allowInactive: boolean } {
  const tokens = raw.trim() ? raw.trim().split(/\s+/) : [];
  let scope: ConfigScope = "session";
  let allowInactive = false;
  let value: string | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--allow-inactive") {
      allowInactive = true;
    } else if (token === "--scope") {
      const candidate = tokens[++index];
      if (!candidate || !["session", "workspace", "global"].includes(candidate)) throw new Error("--scope requires session, workspace, or global");
      scope = candidate as ConfigScope;
    } else if (token.startsWith("--scope=")) {
      const candidate = token.slice("--scope=".length);
      if (!["session", "workspace", "global"].includes(candidate)) throw new Error("--scope requires session, workspace, or global");
      scope = candidate as ConfigScope;
    } else if (token.startsWith("--")) {
      throw new Error(`unknown option: ${token}`);
    } else if (value === undefined) {
      value = token;
    } else {
      throw new Error("only one policy value or reset action may be specified");
    }
  }
  return { value, scope, allowInactive };
}

export function parseKnowledgeModelArgs(raw: string): KnowledgeModelArgs {
  const parsed = parseScopeOptions(raw);
  if (!parsed.value) return { scope: parsed.scope, allowInactive: parsed.allowInactive };
  if (parsed.value === "reset") return { action: "reset", scope: parsed.scope, allowInactive: parsed.allowInactive };
  return { action: "set", policy: parseModelReference(parsed.value), scope: parsed.scope, allowInactive: parsed.allowInactive };
}

export function parseKnowledgeMaterializerArgs(raw: string): KnowledgeMaterializerArgs {
  const parsed = parseScopeOptions(raw);
  if (parsed.allowInactive) throw new Error("--allow-inactive applies only to extraction model configuration");
  if (!parsed.value) return { scope: parsed.scope };
  if (parsed.value === "reset") return { action: "reset", scope: parsed.scope };
  return { action: "set", policy: parseMaterializerPolicy(parsed.value), scope: parsed.scope };
}

export type QueueCounts = Record<"pending" | "running" | "retry-wait" | "failed" | "review-ready", number>;

export function summarizeQueue(jobs: Pick<KnowledgeJob, "state">[]): QueueCounts {
  const counts: QueueCounts = { pending: 0, running: 0, "retry-wait": 0, failed: 0, "review-ready": 0 };
  for (const job of jobs) {
    if (job.state in counts) counts[job.state as keyof QueueCounts] += 1;
  }
  return counts;
}

export type SafeJobDiagnostic = {
  category:
    | "no-diagnostic"
    | "materializer-command-exited"
    | "command-binding-unavailable"
    | "credentials-unavailable"
    | "model-unavailable"
    | "extraction-timeout"
    | "invalid-model-configuration"
    | "background-failure";
  exitCode?: number;
};

/** Converts untrusted durable error text into an allowlisted UI-safe category. */
export function safeJobDiagnostic(error: string | undefined): SafeJobDiagnostic {
  if (!error) return { category: "no-diagnostic" };
  const commandExit = /Materializer exited\s+(\d{1,3})(?:\D|$)/i.exec(error);
  if (commandExit) return { category: "materializer-command-exited", exitCode: Number(commandExit[1]) };
  if (/Configured command materializer binding is unavailable/i.test(error)) return { category: "command-binding-unavailable" };
  if (/Credentials unavailable/i.test(error)) return { category: "credentials-unavailable" };
  if (/Configured extraction model is unavailable|No active model available/i.test(error)) return { category: "model-unavailable" };
  if (/Background extraction timed out/i.test(error)) return { category: "extraction-timeout" };
  if (/Invalid SHARED_KNOWLEDGE_EXTRACTION_MODEL/i.test(error)) return { category: "invalid-model-configuration" };
  return { category: "background-failure" };
}

export function formatSafeJobDiagnostic(diagnostic: SafeJobDiagnostic): string {
  const labels: Record<SafeJobDiagnostic["category"], string> = {
    "no-diagnostic": "no diagnostic",
    "materializer-command-exited": "materializer command exited",
    "command-binding-unavailable": "command binding unavailable",
    "credentials-unavailable": "model credentials unavailable",
    "model-unavailable": "extraction model unavailable",
    "extraction-timeout": "background extraction timed out",
    "invalid-model-configuration": "invalid extraction model configuration",
    "background-failure": "background job failed",
  };
  return diagnostic.exitCode === undefined ? labels[diagnostic.category] : `${labels[diagnostic.category]} (${diagnostic.exitCode})`;
}

export type JobRecoverySummary = {
  id: string;
  state: "failed";
  attempts: number;
  createdAt: string;
  updatedAt: string;
  modelHint?: string;
  hasPayload: boolean;
  retryable: boolean;
  diagnostic: SafeJobDiagnostic;
};

function safeModelHint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/[\r\n\t]/g, " ").trim().slice(0, 240);
  return normalized || undefined;
}

export function failedJobSummaries(jobs: KnowledgeJob[]): JobRecoverySummary[] {
  return jobs
    .filter((job): job is KnowledgeJob & { state: "failed" } => job.state === "failed")
    .map((job) => ({
      id: job.id,
      state: "failed",
      attempts: job.attempts,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      modelHint: safeModelHint(job.modelHint),
      hasPayload: Boolean(job.payload),
      retryable: Boolean(job.payload),
      diagnostic: safeJobDiagnostic(job.error),
    }));
}

export function retryableFailedJobIds(jobs: KnowledgeJob[]): string[] {
  return failedJobSummaries(jobs).filter((job) => job.retryable).map((job) => job.id);
}

export function modelArgumentCompletions(models: Array<{ provider: string; id: string }>, prefix: string): string[] {
  const modelValues = ["active", "reset", ...models.map((model) => `${model.provider}/${model.id}`)]
    .filter((value, index, all) => all.indexOf(value) === index)
    .sort();
  const trimmed = prefix.trim();
  const tokens = trimmed ? trimmed.split(/\s+/) : [];
  const endsWithSpace = /\s$/.test(prefix);
  if (tokens.length === 0) return modelValues;
  if (tokens.length === 1 && !endsWithSpace) return modelValues.filter((value) => value.startsWith(tokens[0]));
  const last = endsWithSpace ? "" : tokens.at(-1)!;
  const beforeLast = endsWithSpace ? tokens : tokens.slice(0, -1);
  if (beforeLast.at(-1) === "--scope") {
    return ["session", "workspace", "global"]
      .filter((scope) => scope.startsWith(last))
      .map((scope) => [...beforeLast, scope].join(" "));
  }
  if (last.startsWith("--scope=")) {
    const scopePrefix = last.slice("--scope=".length);
    return ["session", "workspace", "global"]
      .filter((scope) => scope.startsWith(scopePrefix))
      .map((scope) => [...beforeLast, `--scope=${scope}`].join(" "));
  }
  const options = ["--scope session", "--scope workspace", "--scope global", "--allow-inactive"];
  return options
    .filter((option) => option.startsWith(last))
    .map((option) => [...beforeLast, option].join(" "));
}

export function materializerArgumentCompletions(prefix: string): string[] {
  const values = ["review", "inbox", "command", "reset"];
  const trimmed = prefix.trim();
  const tokens = trimmed ? trimmed.split(/\s+/) : [];
  const endsWithSpace = /\s$/.test(prefix);
  if (tokens.length === 0) return values;
  if (tokens.length === 1 && !endsWithSpace) return values.filter((value) => value.startsWith(tokens[0]));
  const last = endsWithSpace ? "" : tokens.at(-1)!;
  const beforeLast = endsWithSpace ? tokens : tokens.slice(0, -1);
  if (beforeLast.at(-1) === "--scope") {
    return ["session", "workspace", "global"]
      .filter((scope) => scope.startsWith(last))
      .map((scope) => [...beforeLast, scope].join(" "));
  }
  if (last.startsWith("--scope=")) {
    const scopePrefix = last.slice("--scope=".length);
    return ["session", "workspace", "global"]
      .filter((scope) => scope.startsWith(scopePrefix))
      .map((scope) => [...beforeLast, `--scope=${scope}`].join(" "));
  }
  return ["--scope session", "--scope workspace", "--scope global"]
    .filter((option) => option.startsWith(last))
    .map((option) => [...beforeLast, option].join(" "));
}

export function isJobState(value: string): value is JobState {
  return ["pending", "running", "retry-wait", "failed", "review-ready", "done", "skipped"].includes(value);
}
