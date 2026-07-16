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

export const KNOWLEDGE_CONFIG_VERSION = 1;
export const EXTRACTION_MODEL_ENV = "SHARED_KNOWLEDGE_EXTRACTION_MODEL";

export type ConfigScope = "session" | "workspace" | "global";
export type ModelPolicy =
  | { mode: "active" }
  | { mode: "fixed"; provider: string; modelId: string };
export type EffectiveModelPolicy = {
  policy?: ModelPolicy;
  source: "environment" | ConfigScope | "active";
  locked: boolean;
  error?: string;
  diagnostics: string[];
};
export type ConfigDocument = { version: 1; extractionModel: ModelPolicy };

const PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MODEL_RE = /^\S{1,240}$/;
const ALLOWED_DOCUMENT_KEYS = new Set(["version", "extractionModel"]);
const ALLOWED_ACTIVE_KEYS = new Set(["mode"]);
const ALLOWED_FIXED_KEYS = new Set(["mode", "provider", "modelId"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
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

export function formatModelPolicy(policy: ModelPolicy): string {
  return policy.mode === "active" ? "active" : `${policy.provider}/${policy.modelId}`;
}

export function decodeConfig(value: unknown): ConfigDocument {
  if (!isRecord(value) || !hasOnlyKeys(value, ALLOWED_DOCUMENT_KEYS) || value.version !== KNOWLEDGE_CONFIG_VERSION) {
    throw new Error("unsupported or malformed config document");
  }
  const model = value.extractionModel;
  if (!isRecord(model) || typeof model.mode !== "string") throw new Error("missing extraction model policy");
  if (model.mode === "active" && hasOnlyKeys(model, ALLOWED_ACTIVE_KEYS)) {
    return { version: 1, extractionModel: { mode: "active" } };
  }
  if (
    model.mode === "fixed"
    && hasOnlyKeys(model, ALLOWED_FIXED_KEYS)
    && typeof model.provider === "string"
    && typeof model.modelId === "string"
  ) {
    const parsed = parseModelReference(`${model.provider}/${model.modelId}`);
    if (parsed.mode !== "fixed" || parsed.provider !== model.provider || parsed.modelId !== model.modelId) {
      throw new Error("fixed model policy is invalid");
    }
    return { version: 1, extractionModel: parsed };
  }
  throw new Error("invalid extraction model policy");
}

export type ReadConfigResult = { policy?: ModelPolicy; diagnostic?: string };

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
    const raw = readFileSync(path, "utf8");
    if (Buffer.byteLength(raw) > 16_384) return { diagnostic: `config file is too large: ${path}` };
    return { policy: decodeConfig(JSON.parse(raw)).extractionModel };
  } catch {
    return { diagnostic: `invalid or unreadable config at ${path}` };
  }
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export function writeConfig(path: string, policy: ModelPolicy): void {
  ensurePrivateDirectory(dirname(path));
  if (pathInfo(path)?.isSymbolicLink()) throw new Error(`refusing symlink config: ${path}`);
  const temp = join(dirname(path), `.${process.pid}-${randomUUID()}-shared-knowledge.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify({ version: 1, extractionModel: policy }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
    chmodSync(path, 0o600);
  } finally {
    if (existsSync(temp)) rmSync(temp, { force: true });
  }
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
      return { policy: parseModelReference(rawEnvironment), source: "environment", locked: true, diagnostics };
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

export function parseKnowledgeModelArgs(raw: string): KnowledgeModelArgs {
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
      throw new Error("only one model or reset action may be specified");
    }
  }
  if (!value) return { scope, allowInactive };
  if (value === "reset") return { action: "reset", scope, allowInactive };
  return { action: "set", policy: parseModelReference(value), scope, allowInactive };
}

export type QueueCounts = Record<"pending" | "running" | "retry-wait" | "failed" | "review-ready", number>;

export function summarizeQueue(jobs: Pick<KnowledgeJob, "state">[]): QueueCounts {
  const counts: QueueCounts = { pending: 0, running: 0, "retry-wait": 0, failed: 0, "review-ready": 0 };
  for (const job of jobs) {
    if (job.state in counts) counts[job.state as keyof QueueCounts] += 1;
  }
  return counts;
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

export function isJobState(value: string): value is JobState {
  return ["pending", "running", "retry-wait", "failed", "review-ready", "done", "skipped"].includes(value);
}
