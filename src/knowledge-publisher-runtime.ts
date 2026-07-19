import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { KnowledgeJob } from "./knowledge-job-runtime.ts";
import { resolveRuntimeRoot } from "./knowledge-job-runtime.ts";
import type { PublisherMode } from "./knowledge-config-runtime.ts";

export const PUBLISH_JOB_VERSION = 1;
const JOB_ID_RE = /^[a-f0-9]{24}$/;
const PUBLISH_STATES = new Set<PublishState>(["pending", "preparing", "validated", "pushed", "pr-open", "waiting", "blocked", "failed", "already-canonical", "merged"]);
const PUBLISH_DIAGNOSTICS = new Set<PublishDiagnostic>(["none", "policy-off", "remote-unsupported", "auth-unavailable", "input-stale", "absorption-blocked", "ignored-output", "validation-failed", "ref-race", "transport-failed", "checks-pending", "checks-failed", "merge-conflict", "review-required", "stale-head", "closed-unmerged"]);
function isSafeOutput(path: string): boolean {
  return path === "AGENTS.md"
    || path === "CLAUDE.md"
    || path.startsWith("knowledge/facts/")
    || path.startsWith("knowledge/followups/")
    || path.startsWith("knowledge/inbox/");
}

export type PublishState =
  | "pending" | "preparing" | "validated" | "pushed" | "pr-open" | "waiting"
  | "blocked" | "failed" | "already-canonical" | "merged";
export type PublishDiagnostic =
  | "none" | "policy-off" | "remote-unsupported" | "auth-unavailable" | "input-stale"
  | "absorption-blocked" | "ignored-output" | "validation-failed" | "ref-race"
  | "transport-failed" | "checks-pending" | "checks-failed" | "merge-conflict"
  | "review-required" | "stale-head" | "closed-unmerged";
export type PublishInput = { path: string; sha256: string };
export type PublishJob = {
  version: typeof PUBLISH_JOB_VERSION;
  id: string;
  intentKey: string;
  state: PublishState;
  mode: Exclude<PublisherMode, "off">;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  inputs: PublishInput[];
  remote?: string;
  base?: string;
  baseSha?: string;
  branch?: string;
  commitSha?: string;
  prNumber?: number;
  prUrl?: string;
  localValidated?: boolean;
  /** Private crash-recovery path; never included in summaries. */
  worktreePath?: string;
  diagnostic?: PublishDiagnostic;
};
export type SafePublishSummary = Omit<PublishJob, "inputs" | "intentKey" | "worktreePath"> & { inputCount: number };
export type CommandResult = { status: number; stdout: string; stderr: string };
export type CommandRunner = (argv: string[], cwd: string, timeoutMs?: number) => CommandResult;

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isOwnedTempWorktree(path: unknown): path is string {
  if (typeof path !== "string") return false;
  const absolute = resolve(path);
  return dirname(absolute) === resolve(tmpdir()) && /^shared-knowledge-publish-[A-Za-z0-9_-]+$/.test(absolute.split(sep).at(-1) ?? "");
}

function safeRelativePath(cwd: string, path: string): string | undefined {
  if (!path || path.includes("\0")) return undefined;
  const absolute = resolve(cwd, path);
  const rel = relative(resolve(cwd), absolute).split(sep).join("/");
  if (!rel || rel.startsWith("../") || rel === ".." || rel.startsWith(".git/") || rel === ".git") return undefined;
  return rel;
}

function defaultRunner(argv: string[], cwd: string, timeoutMs = 60_000): CommandResult {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    encoding: "utf8",
    shell: false,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      GH_CONFIG_DIR: process.env.GH_CONFIG_DIR,
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return {
    status: result.status ?? 1,
    stdout: String(result.stdout ?? "").slice(0, 1024 * 1024),
    stderr: String(result.stderr ?? "").slice(0, 64 * 1024),
  };
}

function parseJson(value: string): any {
  try { return JSON.parse(value); } catch { return undefined; }
}

function safePrUrl(value: unknown): string | undefined {
  const url = String(value ?? "").trim();
  return /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/.test(url) ? url : undefined;
}

function exactSha(value: string): string {
  const sha = value.trim();
  if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error("ref-race");
  return sha;
}

function checkCategory(error: unknown): PublishDiagnostic {
  const message = String(error);
  for (const value of [
    "policy-off", "remote-unsupported", "auth-unavailable", "input-stale", "absorption-blocked",
    "ignored-output", "validation-failed", "ref-race", "checks-pending", "checks-failed",
    "merge-conflict", "review-required", "stale-head", "closed-unmerged",
  ] as PublishDiagnostic[]) if (message.includes(value)) return value;
  return "transport-failed";
}

function processAlive(pid: unknown): boolean {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function normalizeCheckState(value: unknown): "success" | "pending" | "failed" {
  const state = String(value ?? "").toUpperCase();
  if (state === "SUCCESS") return "success";
  if (["PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED", "WAITING"].includes(state)) return "pending";
  return "failed";
}

function validateJob(value: unknown): PublishJob | undefined {
  if (!value || typeof value !== "object") return undefined;
  const job = value as PublishJob;
  if (
    job.version !== 1 || !JOB_ID_RE.test(job.id) || !/^[a-f0-9]{64}$/.test(job.intentKey)
    || !PUBLISH_STATES.has(job.state) || !["pr", "auto-merge"].includes(job.mode)
    || !Array.isArray(job.inputs) || job.inputs.length < 1 || job.inputs.length > 32
    || job.inputs.some((input) => !input || typeof input.path !== "string" || !/^knowledge\/inbox\/[A-Za-z0-9._-]+\.md$/.test(input.path) || input.path === "knowledge/inbox/README.md" || !/^[a-f0-9]{64}$/.test(input.sha256))
    || !Number.isSafeInteger(job.attempts) || job.attempts < 0
    || (job.diagnostic !== undefined && !PUBLISH_DIAGNOSTICS.has(job.diagnostic))
    || (job.remote !== undefined && !/^[A-Za-z0-9._-]{1,80}$/.test(job.remote))
    || (job.base !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(job.base) || job.base.includes("..")))
    || (job.branch !== undefined && !/^shared-knowledge\/publish-[a-f0-9]{24}$/.test(job.branch))
    || (job.commitSha !== undefined && !/^[a-f0-9]{40,64}$/.test(job.commitSha))
    || (job.baseSha !== undefined && !/^[a-f0-9]{40,64}$/.test(job.baseSha))
    || (job.worktreePath !== undefined && !isOwnedTempWorktree(job.worktreePath))
  ) return undefined;
  return job;
}

export class KnowledgePublisherQueue {
  readonly root: string;
  readonly jobsDir: string;

  constructor(readonly cwd: string, env: NodeJS.ProcessEnv = process.env) {
    this.root = join(resolveRuntimeRoot(cwd, env), "publisher");
    this.jobsDir = join(this.root, "jobs");
    mkdirSync(this.jobsDir, { recursive: true, mode: 0o700 });
    chmodSync(this.jobsDir, 0o700);
  }

  list(): PublishJob[] {
    return readdirSync(this.jobsDir).filter((name) => name.endsWith(".json")).sort().flatMap((name) => {
      try {
        const job = validateJob(JSON.parse(readFileSync(join(this.jobsDir, name), "utf8")));
        return job ? [job] : [];
      } catch { return []; }
    });
  }

  read(id: string): PublishJob | undefined {
    if (!JOB_ID_RE.test(id)) return undefined;
    try { return validateJob(JSON.parse(readFileSync(join(this.jobsDir, `${id}.json`), "utf8"))); } catch { return undefined; }
  }

  update(id: string, patch: Partial<PublishJob>): PublishJob {
    const current = this.read(id);
    if (!current) throw new Error("publish job unavailable");
    const next = { ...current, ...patch, id: current.id, version: 1 as const, updatedAt: new Date().toISOString() };
    atomicJson(join(this.jobsDir, `${id}.json`), next);
    return next;
  }

  summaries(): SafePublishSummary[] {
    return this.list().map(({ inputs, intentKey: _intentKey, worktreePath: _worktreePath, ...job }) => ({
      ...job,
      ...(job.prUrl ? { prUrl: safePrUrl(job.prUrl) } : {}),
      inputCount: inputs.length,
    }));
  }

  enqueue(inputs: PublishInput[], mode: Exclude<PublisherMode, "off">): PublishJob | undefined {
    const normalized = inputs.flatMap((input) => {
      const path = safeRelativePath(this.cwd, input.path);
      return path && /^knowledge\/inbox\/[A-Za-z0-9._-]+\.md$/.test(path) && path !== "knowledge/inbox/README.md" && /^[a-f0-9]{64}$/.test(input.sha256)
        ? [{ path, sha256: input.sha256 }]
        : [];
    }).sort((a, b) => a.path.localeCompare(b.path));
    if (!normalized.length) return undefined;
    if (normalized.length > 32) throw new Error("publish intent exceeds bounded input count");
    const intentKey = createHash("sha256").update(`${resolve(this.cwd)}\0${normalized.map((v) => `${v.path}\0${v.sha256}`).join("\0")}`).digest("hex");
    const existing = this.list().find((job) => job.intentKey === intentKey);
    if (existing) return existing;
    const id = intentKey.slice(0, 24);
    const now = new Date().toISOString();
    const job: PublishJob = { version: 1, id, intentKey, state: "pending", mode, createdAt: now, updatedAt: now, attempts: 0, inputs: normalized };
    atomicJson(join(this.jobsDir, `${id}.json`), job);
    return job;
  }

  reconcile(reviewJobs: KnowledgeJob[], mode: PublisherMode): PublishJob[] {
    if (mode === "off") return [];
    const created: PublishJob[] = [];
    const existingAuthorities = new Set(this.list().flatMap((job) => job.inputs.map((input) => `${input.path}\0${input.sha256}`)));
    const owned = new Map<string, PublishInput>();
    for (const job of reviewJobs) {
      if (job.state !== "done" || job.result?.materializer !== "review") continue;
      for (const decision of Object.values(job.result.reviewDecisions ?? {})) {
        if (decision.state !== "approved" || typeof decision.inboxPath !== "string") continue;
        const path = safeRelativePath(this.cwd, decision.inboxPath);
        if (!path) continue;
        const absolute = join(this.cwd, path);
        try {
          const info = lstatSync(absolute);
          if (!info.isFile() || info.isSymbolicLink()) continue;
          const input = { path, sha256: sha256File(absolute) };
          const authority = `${input.path}\0${input.sha256}`;
          if (!existingAuthorities.has(authority)) owned.set(authority, input);
        } catch { /* expired/missing input remains manual */ }
      }
    }
    const inputs = [...owned.values()];
    for (let index = 0; index < inputs.length; index += 32) {
      const job = this.enqueue(inputs.slice(index, index + 32), mode);
      if (job) created.push(job);
    }
    return created;
  }

  retry(id: string): PublishJob {
    const job = this.read(id);
    if (!job || !["failed", "blocked", "waiting"].includes(job.state)) throw new Error("publish job is not retryable");
    return this.update(id, { state: job.prNumber ? "waiting" : "pending", diagnostic: "none", attempts: 0 });
  }
}

export type PublisherRuntimeOptions = {
  remote?: string;
  absorberScript: string;
  lintScript: string;
  runner?: CommandRunner;
  policyActive?: (mode: Exclude<PublisherMode, "off">) => boolean;
};

export class KnowledgePublisherRuntime {
  private readonly run: CommandRunner;
  private readonly remote: string;

  constructor(readonly queue: KnowledgePublisherQueue, readonly options: PublisherRuntimeOptions) {
    this.run = options.runner ?? defaultRunner;
    this.remote = options.remote ?? "origin";
  }

  async processNext(mode: PublisherMode): Promise<PublishJob | undefined> {
    const lockPath = join(this.queue.root, "publisher.lock");
    const nonce = randomUUID();
    let fd: number | undefined;
    try {
      fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, `${JSON.stringify({ nonce, pid: process.pid, createdAt: new Date().toISOString() })}\n`);
      closeSync(fd);
      fd = undefined;
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        try {
          const metadata = parseJson(readFileSync(lockPath, "utf8"));
          const created = Date.parse(String(metadata?.createdAt ?? ""));
          if (Number.isFinite(created) && Date.now() - created >= 30 * 60_000 && !processAlive(metadata?.pid)) {
            const stale = `${lockPath}.${randomUUID()}.stale`;
            renameSync(lockPath, stale);
            rmSync(stale, { force: true });
            return this.processNext(mode);
          }
        } catch { /* another process owns or recovered the lock */ }
        return undefined;
      }
      throw error;
    }
    try {
      return await this.processNextLocked(mode);
    } finally {
      try {
        const metadata = parseJson(readFileSync(lockPath, "utf8"));
        if (metadata?.nonce === nonce) unlinkSync(lockPath);
      } catch { /* bounded stale-lock recovery is handled on the next explicit retry */ }
    }
  }

  private async processNextLocked(mode: PublisherMode): Promise<PublishJob | undefined> {
    const jobs = this.queue.list();
    const manualOpen = mode === "pr" ? jobs.find((candidate) => ["pr-open", "waiting"].includes(candidate.state) && candidate.prNumber && candidate.attempts < 20) : undefined;
    if (manualOpen) return this.refreshManualPr(manualOpen);
    if (mode === "pr" && jobs.some((candidate) => ["pr-open", "waiting"].includes(candidate.state) && candidate.prNumber)) return undefined;
    const job = jobs.find((candidate) => ["pending", "preparing", "validated", "pushed"].includes(candidate.state))
      ?? (mode === "auto-merge" ? jobs.find((candidate) => ["pr-open", "waiting"].includes(candidate.state) && candidate.prNumber && candidate.attempts < 20) : undefined);
    if (!job) return undefined;
    if (mode === "off") return this.queue.update(job.id, { state: "waiting", diagnostic: "policy-off" });
    if (job.mode !== mode) job.mode = mode;
    if (job.state === "pushed") return this.recoverPushed(job);
    if (job.state === "validated") return this.recoverValidated(job);
    if (job.state === "preparing") job.state = "pending";
    if (job.state !== "pending") {
      try {
        return this.attemptMerge(this.queue.update(job.id, { attempts: job.attempts + 1 }), this.queue.cwd);
      } catch (error) {
        const diagnostic = checkCategory(error);
        return this.queue.update(job.id, { state: ["checks-pending", "review-required"].includes(diagnostic) ? "waiting" : "blocked", diagnostic });
      }
    }
    return this.process(job);
  }

  private requirePolicy(mode: Exclude<PublisherMode, "off">): void {
    if (this.options.policyActive && !this.options.policyActive(mode)) throw new Error("policy-off");
  }

  private command(argv: string[], cwd: string, category: PublishDiagnostic, timeout = 60_000): string {
    const result = this.run(argv, cwd, timeout);
    if (result.status !== 0) throw new Error(category);
    return result.stdout.trim();
  }

  private async process(start: PublishJob): Promise<PublishJob> {
    let job = this.queue.update(start.id, { state: "preparing", attempts: start.attempts + 1, diagnostic: "none" });
    let worktree: string | undefined;
    try {
      const remoteUrl = this.command(["git", "remote", "get-url", this.remote], this.queue.cwd, "remote-unsupported", 30_000);
      if (!/^(?:https?:\/\/github\.com\/|ssh:\/\/(?:git@)?github\.com\/|git@github\.com:)[^/\s]+\/[^/\s]+(?:\.git)?$/.test(remoteUrl)) {
        throw new Error("remote-unsupported");
      }
      this.command(["gh", "auth", "status", "--hostname", "github.com"], this.queue.cwd, "auth-unavailable", 30_000);
      this.command(["git", "fetch", "--quiet", this.remote], this.queue.cwd, "transport-failed", 120_000);
      let base = this.run(["git", "symbolic-ref", "--short", `refs/remotes/${this.remote}/HEAD`], this.queue.cwd, 30_000).stdout.trim();
      base = base.startsWith(`${this.remote}/`) ? base.slice(this.remote.length + 1) : "main";
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(base) || base.includes("..") || base.endsWith("/")) throw new Error("remote-unsupported");
      const baseSha = exactSha(this.command(["git", "rev-parse", `${this.remote}/${base}^{commit}`], this.queue.cwd, "transport-failed", 30_000));
      if (job.worktreePath && isOwnedTempWorktree(job.worktreePath)) {
        this.run(["git", "worktree", "remove", "--force", job.worktreePath], this.queue.cwd, 60_000);
        rmSync(job.worktreePath, { recursive: true, force: true });
      }
      worktree = mkdtempSync(join(tmpdir(), "shared-knowledge-publish-"));
      chmodSync(worktree, 0o700);
      job = this.queue.update(job.id, { worktreePath: worktree });
      this.command(["git", "worktree", "add", "--detach", worktree, baseSha], this.queue.cwd, "transport-failed", 120_000);

      for (const input of job.inputs) {
        const source = join(this.queue.cwd, input.path);
        const info = lstatSync(source);
        if (!info.isFile() || info.isSymbolicLink() || sha256File(source) !== input.sha256) throw new Error("input-stale");
        const target = join(worktree, input.path);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(source, target);
      }

      const planRaw = this.command(["python3", this.options.absorberScript, "--root", worktree, "plan", "--format", "json"], worktree, "absorption-blocked", 120_000);
      const plan = parseJson(planRaw);
      if (!plan || !Array.isArray(plan.actions)) throw new Error("absorption-blocked");
      const allowed = new Set(job.inputs.map((input) => input.path));
      const actions = plan.actions.filter((action: any) => allowed.has(String(action?.candidatePath ?? "")));
      if (!actions.length || actions.some((action: any) => !action.safeToApply)) throw new Error("absorption-blocked");
      const planPath = join(worktree, ".git-shared-knowledge-publish-plan.json");
      writeFileSync(planPath, `${JSON.stringify({ ...plan, actions })}\n`, { mode: 0o600 });
      const applyRaw = this.command(["python3", this.options.absorberScript, "--root", worktree, "apply", "--plan-file", planPath, "--safe-only", "--format", "json"], worktree, "absorption-blocked", 120_000);
      rmSync(planPath, { force: true });
      const apply = parseJson(applyRaw);
      if (!apply || !Array.isArray(apply.changedPaths) || (apply.skipped?.length ?? 0) > 0) throw new Error("absorption-blocked");
      this.command(["python3", this.options.lintScript, "--root", worktree], worktree, "validation-failed", 120_000);

      const statusResult = this.run(["git", "status", "--porcelain", "--untracked-files=all"], worktree, 30_000);
      if (statusResult.status !== 0) throw new Error("validation-failed");
      const changed = statusResult.stdout.split("\n").filter(Boolean).map((line) => line.slice(3).trim().replace(/^"|"$/g, ""));
      if (changed.length > 256 || changed.some((path) => Buffer.byteLength(path) > 1024)) throw new Error("validation-failed");
      if (!changed.length) {
        const allResolved = actions.every((action: any) => ["retain_memory", "merge_into_existing"].includes(action.action));
        if (!allResolved) throw new Error("absorption-blocked");
        this.cleanupInputs(job);
        return this.queue.update(job.id, { state: "already-canonical", base, baseSha, remote: this.remote, localValidated: true });
      }
      const reported = new Set(apply.changedPaths.map((path: unknown) => String(path)));
      for (const path of changed) {
        if (!reported.has(path) || !isSafeOutput(path) || path.startsWith("knowledge/.index/")) throw new Error("validation-failed");
        const ignored = this.run(["git", "check-ignore", "-q", "--", path], worktree, 30_000);
        if (ignored.status === 0) throw new Error("ignored-output");
        if (ignored.status !== 1) throw new Error("validation-failed");
      }
      this.command(["git", "add", "-A", "--", ...changed], worktree, "validation-failed", 30_000);
      this.command(["git", "diff", "--cached", "--check"], worktree, "validation-failed", 30_000);
      this.command(["git", "commit", "-m", "docs: publish reviewed shared knowledge"], worktree, "validation-failed", 60_000);
      const commitSha = exactSha(this.command(["git", "rev-parse", "HEAD^{commit}"], worktree, "validation-failed", 30_000));
      const branch = `shared-knowledge/publish-${job.id}`;
      job = this.queue.update(job.id, { state: "validated", remote: this.remote, base, baseSha, branch, commitSha, localValidated: true });
      const remoteLookup = this.run(["git", "ls-remote", "--heads", this.remote, `refs/heads/${branch}`], worktree, 30_000);
      if (remoteLookup.status !== 0) throw new Error("transport-failed");
      const remoteHead = remoteLookup.stdout.trim();
      if (remoteHead && !remoteHead.startsWith(`${commitSha}\t`)) throw new Error("ref-race");
      if (!remoteHead) {
        this.requirePolicy(job.mode);
        this.command(["git", "push", this.remote, `HEAD:refs/heads/${branch}`], worktree, "transport-failed", 120_000);
      }
      job = this.queue.update(job.id, { state: "pushed" });

      const existingRaw = this.command(["gh", "pr", "list", "--head", branch, "--state", "all", "--json", "number,url,state,headRefOid,baseRefName"], worktree, "transport-failed", 30_000);
      const existing = parseJson(existingRaw);
      let pr = Array.isArray(existing) ? existing.find((value: any) => value.state === "OPEN" && value.headRefOid === commitSha && value.baseRefName === base) : undefined;
      if (pr) {
        const verified = parseJson(this.command(["gh", "pr", "view", String(pr.number), "--json", "number,url,state,headRefOid,baseRefName,body"], worktree, "transport-failed", 30_000));
        const marker = `<!-- shared-knowledge-publisher:v1 job=${job.id} sha=${commitSha} -->`;
        if (!verified || verified.state !== "OPEN" || verified.headRefOid !== commitSha || verified.baseRefName !== base || !String(verified.body ?? "").includes(marker)) {
          throw new Error("ref-race");
        }
        pr = verified;
      }
      if (!pr) {
        this.requirePolicy(job.mode);
        const rawUrl = this.command(["gh", "pr", "create", "--base", base, "--head", branch, "--title", "docs: publish reviewed shared knowledge", "--body", `Automated canonical publication of explicitly reviewed Shared Knowledge.\n\n<!-- shared-knowledge-publisher:v1 job=${job.id} sha=${commitSha} -->`], worktree, "transport-failed", 60_000);
        const url = safePrUrl(rawUrl);
        const numberMatch = url ? /\/(\d+)$/.exec(url) : undefined;
        if (!url || !numberMatch) throw new Error("transport-failed");
        pr = { number: Number(numberMatch[1]), url, state: "OPEN", headRefOid: commitSha, baseRefName: base };
      }
      const prUrl = safePrUrl(pr.url);
      if (!Number.isSafeInteger(Number(pr.number)) || Number(pr.number) < 1 || !prUrl) throw new Error("transport-failed");
      job = this.queue.update(job.id, { state: "pr-open", prNumber: Number(pr.number), prUrl });
      this.requirePolicy(job.mode);
      this.cleanupInputs(job);
      if (job.mode === "pr") return job;
      return this.attemptMerge(job, worktree);
    } catch (error) {
      const diagnostic = checkCategory(error);
      const state: PublishState = diagnostic === "policy-off"
        ? job.state
        : ["checks-pending", "review-required"].includes(diagnostic) ? "waiting" : "blocked";
      return this.queue.update(job.id, { state, diagnostic });
    } finally {
      if (worktree) {
        this.run(["git", "worktree", "remove", "--force", worktree], this.queue.cwd, 60_000);
        rmSync(worktree, { recursive: true, force: true });
        try { this.queue.update(start.id, { worktreePath: undefined }); } catch { /* job may have become unavailable */ }
      }
    }
  }

  private cleanupInputs(job: PublishJob): void {
    for (const input of job.inputs) {
      const path = join(this.queue.cwd, input.path);
      try {
        const info = lstatSync(path);
        if (info.isFile() && !info.isSymbolicLink() && sha256File(path) === input.sha256) unlinkSync(path);
      } catch { /* stale/missing paths are intentionally untouched */ }
    }
  }

  private recoverValidated(job: PublishJob): PublishJob {
    try {
      if (!job.branch || !job.commitSha || !job.base || !job.baseSha || !job.localValidated) throw new Error("ref-race");
      this.command(["gh", "auth", "status", "--hostname", "github.com"], this.queue.cwd, "auth-unavailable", 30_000);
      const lookup = this.run(["git", "ls-remote", "--heads", job.remote ?? this.remote, `refs/heads/${job.branch}`], this.queue.cwd, 30_000);
      if (lookup.status !== 0) throw new Error("transport-failed");
      const remoteHead = lookup.stdout.trim();
      if (remoteHead && !remoteHead.startsWith(`${job.commitSha}\t`)) throw new Error("ref-race");
      if (!remoteHead) {
        this.requirePolicy(job.mode);
        this.command(["git", "push", job.remote ?? this.remote, `${job.commitSha}:refs/heads/${job.branch}`], this.queue.cwd, "transport-failed", 120_000);
      }
      return this.recoverPushed(this.queue.update(job.id, { state: "pushed", attempts: job.attempts + 1 }));
    } catch (error) {
      const diagnostic = checkCategory(error);
      return this.queue.update(job.id, { state: diagnostic === "policy-off" ? "validated" : "blocked", diagnostic, attempts: job.attempts + 1 });
    }
  }

  private recoverPushed(job: PublishJob): PublishJob {
    try {
      if (!job.branch || !job.commitSha || !job.base) throw new Error("ref-race");
      this.command(["gh", "auth", "status", "--hostname", "github.com"], this.queue.cwd, "auth-unavailable", 30_000);
      const lookup = this.run(["git", "ls-remote", "--heads", job.remote ?? this.remote, `refs/heads/${job.branch}`], this.queue.cwd, 30_000);
      if (lookup.status !== 0 || !lookup.stdout.trim().startsWith(`${job.commitSha}\t`)) throw new Error("ref-race");
      const listed = parseJson(this.command(["gh", "pr", "list", "--head", job.branch, "--state", "all", "--json", "number,url,state,headRefOid,baseRefName"], this.queue.cwd, "transport-failed", 30_000));
      let pr = Array.isArray(listed) ? listed.find((value: any) => value.state === "OPEN" && value.headRefOid === job.commitSha && value.baseRefName === job.base) : undefined;
      const marker = `<!-- shared-knowledge-publisher:v1 job=${job.id} sha=${job.commitSha} -->`;
      if (!pr) {
        this.requirePolicy(job.mode);
        const rawUrl = this.command(["gh", "pr", "create", "--base", job.base, "--head", job.branch, "--title", "docs: publish reviewed shared knowledge", "--body", `Automated canonical publication of explicitly reviewed Shared Knowledge.\n\n${marker}`], this.queue.cwd, "transport-failed", 60_000);
        const url = safePrUrl(rawUrl);
        const match = url ? /\/(\d+)$/.exec(url) : undefined;
        if (!url || !match) throw new Error("transport-failed");
        pr = { number: Number(match[1]), url };
      } else {
        const verified = parseJson(this.command(["gh", "pr", "view", String(pr.number), "--json", "number,url,state,headRefOid,baseRefName,body"], this.queue.cwd, "transport-failed", 30_000));
        if (!verified || !String(verified.body ?? "").includes(marker)) throw new Error("ref-race");
        pr = verified;
      }
      const prUrl = safePrUrl(pr.url);
      if (!Number.isSafeInteger(Number(pr.number)) || Number(pr.number) < 1 || !prUrl) throw new Error("transport-failed");
      const ready = this.queue.update(job.id, { state: "pr-open", prNumber: Number(pr.number), prUrl, attempts: job.attempts + 1 });
      this.requirePolicy(ready.mode);
      this.cleanupInputs(ready);
      return ready.mode === "auto-merge" ? this.attemptMerge(ready, this.queue.cwd) : ready;
    } catch (error) {
      const diagnostic = checkCategory(error);
      return this.queue.update(job.id, { state: diagnostic === "policy-off" ? "pushed" : "blocked", diagnostic, attempts: job.attempts + 1 });
    }
  }

  private refreshManualPr(job: PublishJob): PublishJob {
    this.requirePolicy("pr");
    const result = this.run(["gh", "pr", "view", String(job.prNumber), "--json", "state,headRefOid,baseRefName,url,body"], this.queue.cwd, 30_000);
    if (result.status !== 0) return this.queue.update(job.id, { attempts: job.attempts + 1, diagnostic: "transport-failed" });
    const pr = parseJson(result.stdout);
    const marker = `<!-- shared-knowledge-publisher:v1 job=${job.id} sha=${job.commitSha} -->`;
    if (pr?.headRefOid !== job.commitSha || pr?.baseRefName !== job.base || !String(pr?.body ?? "").includes(marker)) {
      return this.queue.update(job.id, { state: "blocked", attempts: job.attempts + 1, diagnostic: "stale-head" });
    }
    if (pr.state === "MERGED") {
      this.cleanupInputs(job);
      return this.queue.update(job.id, { state: "merged", attempts: job.attempts + 1, diagnostic: "none" });
    }
    if (pr.state === "CLOSED") return this.queue.update(job.id, { state: "blocked", attempts: job.attempts + 1, diagnostic: "closed-unmerged" });
    this.cleanupInputs(job);
    return this.queue.update(job.id, { state: "pr-open", attempts: job.attempts + 1, diagnostic: "none" });
  }

  private attemptMerge(job: PublishJob, cwd: string): PublishJob {
    this.requirePolicy("auto-merge");
    if (!job.prNumber || !job.commitSha || !job.base || !job.localValidated) throw new Error("stale-head");
    const raw = this.command(["gh", "pr", "view", String(job.prNumber), "--json", "state,mergeable,headRefOid,baseRefName,statusCheckRollup,url,body"], cwd, "transport-failed", 30_000);
    const pr = parseJson(raw);
    if (!pr) throw new Error("closed-unmerged");
    const marker = `<!-- shared-knowledge-publisher:v1 job=${job.id} sha=${job.commitSha} -->`;
    if (pr.headRefOid !== job.commitSha || pr.baseRefName !== job.base || !String(pr.body ?? "").includes(marker)) throw new Error("stale-head");
    if (pr.state === "MERGED") return this.queue.update(job.id, { state: "merged", diagnostic: "none" });
    if (pr.state !== "OPEN") throw new Error("closed-unmerged");
    this.cleanupInputs(job);
    if (pr.mergeable === "CONFLICTING") throw new Error("merge-conflict");
    if (pr.mergeable !== "MERGEABLE") throw new Error("checks-pending");
    const checks = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
    const states = checks.map((check: any) => normalizeCheckState(check.conclusion ?? check.state ?? check.status));
    if (states.includes("failed")) throw new Error("checks-failed");
    if (states.includes("pending")) throw new Error("checks-pending");
    const merged = this.run(["gh", "pr", "merge", String(job.prNumber), "--squash", "--delete-branch"], cwd, 120_000);
    if (merged.status !== 0) {
      const probe = this.run(["gh", "pr", "view", String(job.prNumber), "--json", "state,headRefOid,baseRefName"], cwd, 30_000);
      return this.queue.update(job.id, {
        state: "waiting",
        diagnostic: probe.status === 0 ? "review-required" : "transport-failed",
      });
    }
    return this.queue.update(job.id, { state: "merged", diagnostic: "none" });
  }
}
