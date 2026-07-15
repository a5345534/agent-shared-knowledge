import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const JOB_VERSION = 1 as const;
export const DEFAULT_RETENTION_DAYS = 7;
export const DEFAULT_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;

export type JobState =
  | "pending" | "running" | "retry-wait" | "review-ready"
  | "done" | "skipped" | "failed";

export type CapturedPayload = {
  version: typeof JOB_VERSION;
  workspace: string;
  sessionId: string;
  capturedAt: string;
  conversation: string;
  truncated: boolean;
  originalBytes: number;
  source?: { instanceId: string; runId: string; snapshot?: string; revision?: string; evidencePaths?: string[] };
};

export type KnowledgeJob = {
  version: typeof JOB_VERSION;
  id: string;
  payloadHash: string;
  state: JobState;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  nextAttemptAt?: string;
  modelHint?: string;
  error?: string;
  result?: { candidateCount: number; materializer: "review" | "inbox" | "command"; written: string[]; reviewCandidates?: Array<Record<string, unknown>> };
  payload?: CapturedPayload;
};

export type QueueConfig = {
  maxPayloadBytes: number;
  retentionDays: number;
  maxAttempts: number;
  debounceMs: number;
  maxBatchJobs: number;
  excludePatterns?: string[];
};

export function parseQueueConfig(env: NodeJS.ProcessEnv = process.env): QueueConfig {
  const integer = (name: string, fallback: number, min: number) => {
    const value = Number.parseInt(env[name] ?? "", 10);
    return Number.isFinite(value) && value >= min ? value : fallback;
  };
  let excludePatterns: string[] = [];
  try {
    const parsed = JSON.parse(env.SHARED_KNOWLEDGE_EXCLUDE_PATTERNS ?? "[]") as unknown;
    if (Array.isArray(parsed)) excludePatterns = parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
  } catch {
    excludePatterns = [];
  }
  return {
    maxPayloadBytes: integer("SHARED_KNOWLEDGE_MAX_JOB_BYTES", DEFAULT_MAX_PAYLOAD_BYTES, 1024),
    retentionDays: integer("SHARED_KNOWLEDGE_JOB_RETENTION_DAYS", DEFAULT_RETENTION_DAYS, 0),
    maxAttempts: integer("SHARED_KNOWLEDGE_JOB_MAX_ATTEMPTS", 3, 1),
    debounceMs: integer("SHARED_KNOWLEDGE_JOB_DEBOUNCE_MS", 3000, 0),
    maxBatchJobs: integer("SHARED_KNOWLEDGE_MAX_BATCH_JOBS", 4, 1),
    excludePatterns,
  };
}

function safeWorkspaceKey(cwd: string): string {
  const canonical = resolve(cwd);
  return `${basename(canonical).replace(/[^A-Za-z0-9._-]/g, "-")}-${createHash("sha256").update(canonical).digest("hex").slice(0, 12)}`;
}

export function resolveRuntimeRoot(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.SHARED_KNOWLEDGE_RUNTIME_DIR) {
    return resolve(env.SHARED_KNOWLEDGE_RUNTIME_DIR, safeWorkspaceKey(cwd));
  }
  try {
    const gitPath = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "shared-knowledge"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
    if (gitPath) return resolve(gitPath);
  } catch {
    // Fall through to XDG state.
  }
  const stateHome = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(stateHome, "shared-knowledge", safeWorkspaceKey(cwd));
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function atomicJson(path: string, value: unknown): void {
  ensurePrivateDir(dirname(path));
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export function normalizeConversation(
  conversation: string,
  maxBytes = DEFAULT_MAX_PAYLOAD_BYTES,
  excludePatterns: string[] = [],
): { text: string; truncated: boolean; originalBytes: number } {
  const filtered = conversation.split("\n").filter((line) => !excludePatterns.some((pattern) => line.includes(pattern))).join("\n");
  const withoutBinary = filtered
    .replace(/data:[^;\s]+;base64,[A-Za-z0-9+/=]{256,}/g, "[binary content omitted]")
    .replace(/([A-Za-z0-9+/]{512,}={0,2})/g, "[binary-like content omitted]")
    .replace(/(?:^|\n)(?:\s*(?:npm|pnpm|pip|pytest|tsc|make)[^\n]*\n)?(?:.{0,200}\b(?:PASS|DEBUG|downloaded|progress)\b.*\n){20,}/gi, "\n[repetitive tool output omitted]\n");
  const bytes = Buffer.from(withoutBinary);
  if (bytes.length <= maxBytes) return { text: withoutBinary, truncated: false, originalBytes: bytes.length };
  const marker = "\n[shared-knowledge payload truncated]\n";
  const markerBytes = Buffer.byteLength(marker);
  const headSize = Math.max(0, Math.floor((maxBytes - markerBytes) * 0.65));
  const tailSize = Math.max(0, maxBytes - markerBytes - headSize);
  return {
    text: `${bytes.subarray(0, headSize).toString("utf8")}${marker}${bytes.subarray(bytes.length - tailSize).toString("utf8")}`,
    truncated: true,
    originalBytes: bytes.length,
  };
}

export function isMeaningfulConversation(text: string): boolean {
  const compact = text.replace(/\[[^\]]+ omitted\]/g, "").replace(/\s+/g, " ").trim();
  if (compact.length < 120) return false;
  const signal = /\b(decid(?:e|ed|ing)|must|shall|never|architecture|invariant|because|root cause|migrat|deprecat|policy|requirement|fix(?:ed)?|決定|必須|禁止|原因|架構|規格)\b/i;
  const roles = (text.match(/(?:user|assistant|tool)/gi) ?? []).length;
  return signal.test(compact) || roles >= 2 || compact.length >= 800;
}

export function createCapturedPayload(cwd: string, sessionId: string, conversation: string, config = parseQueueConfig()): CapturedPayload {
  const normalized = normalizeConversation(conversation, config.maxPayloadBytes, config.excludePatterns ?? []);
  return {
    version: JOB_VERSION,
    workspace: resolve(cwd),
    sessionId,
    capturedAt: new Date().toISOString(),
    conversation: normalized.text,
    truncated: normalized.truncated,
    originalBytes: normalized.originalBytes,
  };
}

export function payloadHash(payload: CapturedPayload): string {
  return createHash("sha256")
    .update(JSON.stringify({ version: payload.version, workspace: payload.workspace, sessionId: payload.sessionId, conversation: payload.conversation }))
    .digest("hex");
}

export class KnowledgeJobQueue {
  readonly root: string;
  readonly jobsDir: string;

  constructor(readonly cwd: string, readonly config = parseQueueConfig(), env: NodeJS.ProcessEnv = process.env) {
    this.root = resolveRuntimeRoot(cwd, env);
    this.jobsDir = join(this.root, "jobs");
    ensurePrivateDir(this.jobsDir);
  }

  enqueue(payload: CapturedPayload, modelHint?: string): { job: KnowledgeJob; created: boolean } {
    const hash = payloadHash(payload);
    const id = hash.slice(0, 24);
    const existing = this.read(id);
    if (existing) return { job: existing, created: false };
    const now = new Date().toISOString();
    const job: KnowledgeJob = {
      version: JOB_VERSION,
      id,
      payloadHash: hash,
      state: "pending",
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      modelHint,
      payload,
    };
    atomicJson(this.path(id), job);
    return { job, created: true };
  }

  read(id: string): KnowledgeJob | null {
    try {
      const value = JSON.parse(readFileSync(this.path(id), "utf8")) as KnowledgeJob;
      return value.version === JOB_VERSION && value.id === id ? value : null;
    } catch {
      return null;
    }
  }

  list(): KnowledgeJob[] {
    if (!existsSync(this.jobsDir)) return [];
    return readdirSync(this.jobsDir)
      .filter((name) => /^[a-f0-9]{24}\.json$/.test(name))
      .map((name) => this.read(name.slice(0, -5)))
      .filter((job): job is KnowledgeJob => job !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  nextReady(now = new Date()): KnowledgeJob | null {
    return this.ready(now)[0] ?? null;
  }

  nextReadyBatch(now = new Date()): KnowledgeJob[] {
    const ready = this.ready(now);
    const first = ready[0];
    if (!first?.payload) return first ? [first] : [];
    return ready.filter((job) => job.payload?.sessionId === first.payload?.sessionId).slice(0, this.config.maxBatchJobs);
  }

  private ready(now: Date): KnowledgeJob[] {
    return this.list().filter((job) =>
      job.state === "pending" || (job.state === "retry-wait" && (!job.nextAttemptAt || Date.parse(job.nextAttemptAt) <= now.getTime()))
    );
  }

  update(id: string, patch: Partial<KnowledgeJob>): KnowledgeJob {
    const current = this.read(id);
    if (!current) throw new Error(`Unknown knowledge job: ${id}`);
    const next = { ...current, ...patch, id: current.id, version: JOB_VERSION, updatedAt: new Date().toISOString() };
    atomicJson(this.path(id), next);
    return next;
  }

  markRetry(id: string, error: unknown): KnowledgeJob {
    const current = this.read(id);
    if (!current) throw new Error(`Unknown knowledge job: ${id}`);
    const attempts = current.attempts + 1;
    const terminal = attempts >= this.config.maxAttempts;
    return this.update(id, {
      attempts,
      state: terminal ? "failed" : "retry-wait",
      nextAttemptAt: terminal ? undefined : new Date(Date.now() + Math.min(60_000, 1000 * 2 ** attempts)).toISOString(),
      error: String(error).slice(0, 500),
    });
  }

  status(): Array<Omit<KnowledgeJob, "payload" | "result"> & { hasPayload: boolean; result?: Omit<NonNullable<KnowledgeJob["result"]>, "reviewCandidates"> }> {
    return this.list().map(({ payload, result, ...job }) => ({
      ...job,
      hasPayload: Boolean(payload),
      result: result ? { candidateCount: result.candidateCount, materializer: result.materializer, written: result.written } : undefined,
    }));
  }

  cleanup({ dryRun = false, now = Date.now() }: { dryRun?: boolean; now?: number } = {}): string[] {
    const cutoff = now - this.config.retentionDays * 86_400_000;
    const terminal = new Set<JobState>(["done", "review-ready", "skipped", "failed"]);
    const removed: string[] = [];
    for (const job of this.list()) {
      if (!terminal.has(job.state) || Date.parse(job.updatedAt) > cutoff) continue;
      removed.push(job.id);
      if (!dryRun) rmSync(this.path(job.id), { force: true });
    }
    return removed;
  }

  recoverRunning(): number {
    let count = 0;
    for (const job of this.list()) {
      if (job.state !== "running") continue;
      this.update(job.id, { state: "pending", error: "Recovered interrupted running job" });
      count += 1;
    }
    return count;
  }

  private path(id: string): string {
    if (!/^[a-f0-9]{24}$/.test(id)) throw new Error("Invalid job id");
    return join(this.jobsDir, `${id}.json`);
  }
}

export function assertPrivateMode(path: string): boolean {
  return (statSync(path).mode & 0o077) === 0;
}
