import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const JOB_VERSION = 1 as const;
export const DEFAULT_RETENTION_DAYS = 7;
export const DEFAULT_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;

const REVIEW_LOCK_WAIT_ATTEMPTS = 8;
const REVIEW_LOCK_WAIT_MS = 30;
const REVIEW_LOCK_STALE_MS = 30_000;

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

export type ReviewCandidate = Record<string, unknown>;
export type ReviewDecisionState = "pending" | "approved" | "rejected";
export type ReviewDecision = {
  state: ReviewDecisionState;
  decidedAt?: string;
  outcome?: "staged" | "already-staged";
  /** Private only: never included in status/recovery output. */
  inboxPath?: string;
};
export type ReviewSummary = {
  pending: number;
  approved: number;
  rejected: number;
  expired: number;
};
export type KnowledgeJobResult = {
  candidateCount: number;
  materializer: "review" | "inbox" | "command";
  written: string[];
  /** Private only: explicitly viewed through a local review surface. */
  reviewCandidates?: ReviewCandidate[];
  /** Private only: item keys, outcomes, and Inbox paths never reach status. */
  reviewDecisions?: Record<string, ReviewDecision>;
  /** Safe aggregate retained after private review detail is purged. */
  reviewSummary?: ReviewSummary;
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
  sessionId?: string;
  sourceInstance?: string;
  purgedAt?: string;
  error?: string;
  result?: KnowledgeJobResult;
  payload?: CapturedPayload;
};

export type QueueConfig = {
  maxPayloadBytes: number;
  retentionDays: number;
  maxAttempts: number;
  debounceMs: number;
  maxBatchJobs: number;
  timeoutMs?: number;
  excludePatterns?: string[];
};

export type ReviewItem = {
  id: string;
  index: number;
  candidate: ReviewCandidate;
  decision: ReviewDecision;
};

export type ReviewJobSummary = {
  id: string;
  state: "review-ready";
  createdAt: string;
  updatedAt: string;
  modelHint?: string;
  candidateCount: number;
  summary: ReviewSummary;
  hasReviewContent: boolean;
};

export type ReviewStagingOutcome = {
  outcome: "staged" | "already-staged";
  /** Private only: persisted in the decision, never returned via status. */
  inboxPath?: string;
};

export type ReviewDecisionResult = {
  status: "approved" | "rejected" | "already-decided" | "unavailable";
  decision?: ReviewDecision;
  job?: KnowledgeJob;
};

export type ReviewCloseResult = {
  status: "closed" | "actionable" | "unavailable";
  outcome?: "empty" | "expired";
  summary?: ReviewSummary;
  job?: KnowledgeJob;
};

type PrivateLock = { path: string; nonce: string };
type LockMetadata = { nonce?: string; pid?: number; createdAt?: string };

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
    timeoutMs: integer("SHARED_KNOWLEDGE_JOB_TIMEOUT_MS", 120_000, 1000),
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
  let current = resolve(cwd);
  while (true) {
    const marker = join(current, ".git");
    if (existsSync(marker)) {
      try {
        const value = readFileSync(marker, "utf8").trim();
        const match = /^gitdir:\s*(.+)$/i.exec(value);
        if (match) return join(resolve(current, match[1]), "shared-knowledge");
      } catch {
        return join(marker, "shared-knowledge");
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedDecision(value: unknown): ReviewDecision {
  if (!isRecord(value)) return { state: "pending" };
  const state = value.state;
  if (state !== "approved" && state !== "rejected") return { state: "pending" };
  return {
    state,
    ...(typeof value.decidedAt === "string" ? { decidedAt: value.decidedAt } : {}),
    ...(value.outcome === "staged" || value.outcome === "already-staged" ? { outcome: value.outcome } : {}),
    ...(typeof value.inboxPath === "string" ? { inboxPath: value.inboxPath } : {}),
  };
}

function boundedNumber(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function safeModelHint(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\r\n\t\x00-\x1F\x7F-\x9F]/g, " ").trim().slice(0, 240);
  return normalized || undefined;
}

function isMaterializer(value: unknown): value is KnowledgeJobResult["materializer"] {
  return value === "review" || value === "inbox" || value === "command";
}

function persistedReviewSummary(value: unknown): ReviewSummary {
  if (!isRecord(value)) return { pending: 0, approved: 0, rejected: 0, expired: 0 };
  return {
    pending: boundedNumber(value.pending),
    approved: boundedNumber(value.approved),
    rejected: boundedNumber(value.rejected),
    expired: boundedNumber(value.expired),
  };
}

function expiredReviewSummary(summary: ReviewSummary): ReviewSummary {
  return {
    pending: 0,
    approved: summary.approved,
    rejected: summary.rejected,
    expired: summary.expired + summary.pending,
  };
}

function reviewCandidates(result: KnowledgeJobResult | undefined): ReviewCandidate[] | undefined {
  if (!Array.isArray(result?.reviewCandidates)) return undefined;
  return result.reviewCandidates.map((candidate) => isRecord(candidate) ? candidate : {});
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function processIsAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function lockMetadata(path: string): LockMetadata | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(value)) return undefined;
    return {
      ...(typeof value.nonce === "string" ? { nonce: value.nonce } : {}),
      ...(typeof value.pid === "number" ? { pid: value.pid } : {}),
      ...(typeof value.createdAt === "string" ? { createdAt: value.createdAt } : {}),
    };
  } catch {
    return undefined;
  }
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

export function reviewItemIdForCandidate(jobId: string, index: number, candidate: ReviewCandidate): string {
  const candidateId = typeof candidate.candidate_id === "string" ? candidate.candidate_id : "";
  return createHash("sha256")
    .update(`${jobId}\u0000${index}\u0000${candidateId}`)
    .digest("hex")
    .slice(0, 24);
}

export function createReviewResult(candidates: ReviewCandidate[]): KnowledgeJobResult {
  return {
    candidateCount: candidates.length,
    materializer: "review",
    written: [],
    ...(candidates.length > 0 ? { reviewCandidates: candidates } : {}),
    reviewSummary: { pending: candidates.length, approved: 0, rejected: 0, expired: 0 },
  };
}

/**
 * Followers in a batched review extraction never own duplicate candidates.
 * Keeping this pure makes lifecycle batch ownership independently testable.
 */
export function batchFollowerPatch(outcome: KnowledgeJob | null | undefined): Pick<KnowledgeJob, "state" | "error" | "payload" | "result"> {
  const reviewOwner = outcome?.state === "review-ready" && outcome.result?.materializer === "review";
  if (reviewOwner) {
    return {
      state: "done",
      error: outcome.error,
      payload: undefined,
      result: { candidateCount: 0, materializer: "review", written: [], reviewSummary: { pending: 0, approved: 0, rejected: 0, expired: 0 } },
    };
  }
  return {
    state: outcome?.state ?? "done",
    error: outcome?.error,
    payload: undefined,
    result: outcome?.result,
  };
}

export class KnowledgeJobQueue {
  readonly root: string;
  readonly jobsDir: string;
  readonly reviewLocksDir: string;

  constructor(readonly cwd: string, readonly config = parseQueueConfig(), env: NodeJS.ProcessEnv = process.env) {
    this.root = resolveRuntimeRoot(cwd, env);
    this.jobsDir = join(this.root, "jobs");
    this.reviewLocksDir = join(this.root, "review-locks");
    ensurePrivateDir(this.jobsDir);
    ensurePrivateDir(this.reviewLocksDir);
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
      sessionId: payload.sessionId,
      sourceInstance: payload.source?.instanceId,
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

  retryFailed(id: string): KnowledgeJob {
    const current = this.read(id);
    if (!current) throw new Error(`Unknown knowledge job: ${id}`);
    if (current.state !== "failed") throw new Error(`Knowledge job ${id} is not failed`);
    if (!current.payload) throw new Error(`Knowledge job ${id} has no retained payload`);
    return this.update(id, {
      state: "pending",
      attempts: 0,
      nextAttemptAt: undefined,
      error: undefined,
      result: undefined,
    });
  }

  reviewJobSummaries(): ReviewJobSummary[] {
    return this.list()
      .filter((job): job is KnowledgeJob & { state: "review-ready" } => job.state === "review-ready")
      .map((job) => {
        const candidates = reviewCandidates(job.result);
        const modelHint = safeModelHint(job.modelHint);
        return {
          id: job.id,
          state: "review-ready",
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
          ...(modelHint ? { modelHint } : {}),
          candidateCount: boundedNumber(job.result?.candidateCount),
          summary: this.summaryForJob(job),
          hasReviewContent: Boolean(candidates && candidates.length > 0),
        };
      });
  }

  reviewItems(id: string): ReviewItem[] {
    const job = this.read(id);
    if (!job || job.state !== "review-ready") return [];
    return this.itemsForJob(job);
  }

  pendingReviewItems(id: string): ReviewItem[] {
    return this.reviewItems(id).filter((item) => item.decision.state === "pending");
  }

  async approveReviewItem(
    id: string,
    itemId: string,
    candidateIdentity: (candidate: ReviewCandidate) => string,
    stage: (candidate: ReviewCandidate) => Promise<ReviewStagingOutcome>,
  ): Promise<ReviewDecisionResult> {
    return this.withReviewLock(`job:${id}`, () =>
      this.withReviewLock(`item:${id}:${itemId}`, async () => {
        const first = this.pendingReviewItem(id, itemId);
        if (!first.item) return first.result;
        const identity = candidateIdentity(first.item.candidate);
        if (!identity) throw new Error("review candidate identity is unavailable");
        return this.withReviewLock(`candidate:${identity}`, async () => {
          const fresh = this.pendingReviewItem(id, itemId);
          if (!fresh.item) return fresh.result;
          if (candidateIdentity(fresh.item.candidate) !== identity) {
            return { status: "unavailable" };
          }
          const staged = await stage(fresh.item.candidate);
          const updated = this.storeReviewDecision(id, itemId, {
            state: "approved",
            decidedAt: new Date().toISOString(),
            outcome: staged.outcome,
            ...(staged.inboxPath ? { inboxPath: staged.inboxPath } : {}),
          });
          return {
            status: "approved",
            job: updated,
            decision: normalizedDecision(updated.result?.reviewDecisions?.[itemId]),
          };
        });
      }),
    );
  }

  async rejectReviewItem(id: string, itemId: string): Promise<ReviewDecisionResult> {
    return this.withReviewLock(`job:${id}`, () =>
      this.withReviewLock(`item:${id}:${itemId}`, async () => {
        const current = this.pendingReviewItem(id, itemId);
        if (!current.item) return current.result;
        const updated = this.storeReviewDecision(id, itemId, {
          state: "rejected",
          decidedAt: new Date().toISOString(),
        });
        return {
          status: "rejected",
          job: updated,
          decision: normalizedDecision(updated.result?.reviewDecisions?.[itemId]),
        };
      }),
    );
  }

  async closeUnavailableReviewJob(id: string): Promise<ReviewCloseResult> {
    return this.withReviewLock(`job:${id}`, async () => {
      const current = this.read(id);
      if (!current || current.state !== "review-ready" || current.result?.materializer !== "review") {
        return { status: "unavailable" };
      }
      const candidates = reviewCandidates(current.result);
      if (candidates && candidates.length > 0) return { status: "actionable" };
      const legacyEmpty = candidates !== undefined
        && candidates.length === 0
        && current.result.candidateCount === 0;
      const unavailable = candidates === undefined
        && (Boolean(current.purgedAt) || isRecord(current.result.reviewSummary));
      if (!legacyEmpty && !unavailable) return { status: "unavailable" };
      const summary = legacyEmpty
        ? { pending: 0, approved: 0, rejected: 0, expired: 0 }
        : expiredReviewSummary(this.summaryForJob(current));
      const result: KnowledgeJobResult = {
        ...current.result,
        reviewCandidates: undefined,
        reviewDecisions: undefined,
        reviewSummary: summary,
      };
      const job = this.update(id, {
        state: "done",
        nextAttemptAt: undefined,
        error: undefined,
        result,
      });
      return { status: "closed", outcome: legacyEmpty ? "empty" : "expired", summary, job };
    });
  }

  status(): Array<Omit<KnowledgeJob, "payload" | "result"> & {
    hasPayload: boolean;
    result?: Pick<KnowledgeJobResult, "candidateCount" | "materializer" | "written" | "reviewSummary">;
  }> {
    return this.list().map((job) => {
      const { payload, result, error: _error, modelHint, ...safeJob } = job;
      const materializer = result && isMaterializer(result.materializer) ? result.materializer : undefined;
      const safeResult = materializer ? {
        candidateCount: boundedNumber(result?.candidateCount),
        materializer,
        written: materializer === "review" ? [] : Array.isArray(result?.written) ? [...result.written] : [],
        ...(materializer === "review" ? { reviewSummary: this.summaryForJob(job) } : {}),
      } : undefined;
      const hint = safeModelHint(modelHint);
      return {
        ...safeJob,
        ...(hint ? { modelHint: hint } : {}),
        hasPayload: Boolean(payload),
        ...(safeResult ? { result: safeResult } : {}),
      };
    });
  }

  async cleanup({ dryRun = false, now = Date.now() }: { dryRun?: boolean; now?: number } = {}): Promise<string[]> {
    const cutoff = now - this.config.retentionDays * 86_400_000;
    const terminal = new Set<JobState>(["done", "review-ready", "skipped", "failed"]);
    const eligible = (job: KnowledgeJob): boolean => {
      const result = job.result;
      const hasPrivateDetail = Boolean(job.payload)
        || Array.isArray(result?.reviewCandidates)
        || isRecord(result?.reviewDecisions);
      return terminal.has(job.state) && Date.parse(job.updatedAt) <= cutoff && hasPrivateDetail;
    };
    const purged: string[] = [];
    for (const snapshot of this.list()) {
      if (!eligible(snapshot)) continue;
      if (dryRun) {
        purged.push(snapshot.id);
        continue;
      }
      await this.withReviewLock(`job:${snapshot.id}`, async () => {
        const job = this.read(snapshot.id);
        if (!job || !eligible(job)) return;
        const result = job.result;
        const reviewSummary = result?.materializer === "review"
          ? (job.state === "review-ready"
            ? expiredReviewSummary(this.summaryForJob(job))
            : this.summaryForJob(job))
          : undefined;
        this.update(job.id, {
          ...(job.state === "review-ready" ? {
            state: "done" as const,
            nextAttemptAt: undefined,
            error: undefined,
          } : {}),
          payload: undefined,
          purgedAt: new Date(now).toISOString(),
          result: result ? {
            ...result,
            reviewCandidates: undefined,
            reviewDecisions: undefined,
            ...(reviewSummary ? { reviewSummary } : {}),
          } : undefined,
        });
        purged.push(job.id);
      });
    }
    return purged;
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

  private itemsForJob(job: KnowledgeJob): ReviewItem[] {
    const candidates = reviewCandidates(job.result);
    if (!candidates) return [];
    return candidates.map((candidate, index) => {
      const id = reviewItemIdForCandidate(job.id, index, candidate);
      return {
        id,
        index,
        candidate,
        decision: normalizedDecision(job.result?.reviewDecisions?.[id]),
      };
    });
  }

  private summaryForJob(job: KnowledgeJob): ReviewSummary {
    const candidates = reviewCandidates(job.result);
    if (!candidates) return persistedReviewSummary(job.result?.reviewSummary);
    const summary: ReviewSummary = {
      pending: 0,
      approved: 0,
      rejected: 0,
      expired: persistedReviewSummary(job.result?.reviewSummary).expired,
    };
    candidates.forEach((candidate, index) => {
      const id = reviewItemIdForCandidate(job.id, index, candidate);
      summary[normalizedDecision(job.result?.reviewDecisions?.[id]).state] += 1;
    });
    return summary;
  }

  private pendingReviewItem(id: string, itemId: string): { item?: ReviewItem; result: ReviewDecisionResult } {
    const job = this.read(id);
    if (!job) return { result: { status: "unavailable" } };
    const item = this.itemsForJob(job).find((candidate) => candidate.id === itemId);
    if (!item) return { result: { status: "unavailable" } };
    if (job.state !== "review-ready" || item.decision.state !== "pending") {
      return { result: { status: "already-decided", job, decision: item.decision } };
    }
    return { item, result: { status: "unavailable" } };
  }

  private storeReviewDecision(id: string, itemId: string, decision: ReviewDecision): KnowledgeJob {
    const current = this.read(id);
    if (!current?.result || current.state !== "review-ready") throw new Error("review item is no longer available");
    const item = this.itemsForJob(current).find((candidate) => candidate.id === itemId);
    if (!item || item.decision.state !== "pending") throw new Error("review item is no longer pending");
    const reviewDecisions = { ...(current.result.reviewDecisions ?? {}), [itemId]: decision };
    const nextResult: KnowledgeJobResult = { ...current.result, reviewDecisions };
    const nextSummary = this.summaryForJob({ ...current, result: nextResult });
    nextResult.reviewSummary = nextSummary;
    return this.update(id, {
      state: nextSummary.pending === 0 ? "done" : "review-ready",
      result: nextResult,
    });
  }

  private async withReviewLock<T>(scope: string, action: () => Promise<T>): Promise<T> {
    const lock = await this.acquireReviewLock(scope);
    try {
      return await action();
    } finally {
      this.releaseReviewLock(lock);
    }
  }

  private async acquireReviewLock(scope: string): Promise<PrivateLock> {
    ensurePrivateDir(this.reviewLocksDir);
    const key = createHash("sha256").update(scope).digest("hex").slice(0, 32);
    const path = join(this.reviewLocksDir, `${key}.lock`);
    const nonce = randomUUID();
    for (let attempt = 0; attempt < REVIEW_LOCK_WAIT_ATTEMPTS; attempt += 1) {
      let fd: number | undefined;
      let created = false;
      try {
        fd = openSync(path, "wx", 0o600);
        created = true;
        writeFileSync(fd, `${JSON.stringify({ nonce, pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");
        closeSync(fd);
        fd = undefined;
        chmodSync(path, 0o600);
        return { path, nonce };
      } catch (error) {
        if (fd !== undefined) closeSync(fd);
        if (created) {
          try { unlinkSync(path); } catch { /* stale-lock recovery handles a leftover partial file */ }
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        if (this.reclaimStaleReviewLock(path)) continue;
        if (attempt < REVIEW_LOCK_WAIT_ATTEMPTS - 1) await delay(REVIEW_LOCK_WAIT_MS);
      }
    }
    throw new Error("review action is busy");
  }

  private reclaimStaleReviewLock(path: string): boolean {
    let stale = false;
    const metadata = lockMetadata(path);
    try {
      const createdAt = metadata?.createdAt ? Date.parse(metadata.createdAt) : statSync(path).mtimeMs;
      stale = Number.isFinite(createdAt) && Date.now() - createdAt >= REVIEW_LOCK_STALE_MS;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
    if (!stale || processIsAlive(metadata?.pid)) return false;
    const reclaimed = `${path}.${randomUUID()}.stale`;
    try {
      renameSync(path, reclaimed);
      rmSync(reclaimed, { force: true });
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }

  private releaseReviewLock(lock: PrivateLock): void {
    try {
      if (lockMetadata(lock.path)?.nonce === lock.nonce) unlinkSync(lock.path);
    } catch {
      // Locks are best-effort cleanup; a later bounded stale-lock recovery owns leftovers.
    }
  }

  private path(id: string): string {
    if (!/^[a-f0-9]{24}$/.test(id)) throw new Error("Invalid job id");
    return join(this.jobsDir, `${id}.json`);
  }
}

export function assertPrivateMode(path: string): boolean {
  return (statSync(path).mode & 0o077) === 0;
}
