import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveRuntimeRoot } from "./knowledge-job-runtime.ts";

export const SESSION_FEEDBACK_VERSION = 1 as const;
export const FEEDBACK_EVIDENCE_WINDOW_DAYS = 90;
export const FEEDBACK_EVIDENCE_WINDOW_MS = FEEDBACK_EVIDENCE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
export const FEEDBACK_PROVENANCE_ENV = "SHARED_KNOWLEDGE_FEEDBACK_PROVENANCE";

const MAX_FINDINGS_PER_INGEST = 16;
const MAX_FINDINGS_TOTAL = 512;
const MAX_CLUSTERS_TOTAL = 256;
const MAX_TEXT = 1_200;
const MAX_EVIDENCE = 400;
const LOCK_STALE_MS = 30_000;

export const FEEDBACK_CLASSIFICATIONS = [
  "upstream-bug",
  "documentation-gap",
  "ux-friction",
  "feature-request",
  "local-configuration",
  "agent-behavior",
  "unresolved-owner",
  "insufficient-evidence",
] as const;
export type FeedbackClassification = typeof FEEDBACK_CLASSIFICATIONS[number];

export const FEEDBACK_COMPONENT_KINDS = [
  "extension",
  "skill",
  "package",
  "pi-core",
  "project",
  "local",
  "unknown",
] as const;
export type FeedbackComponentKind = typeof FEEDBACK_COMPONENT_KINDS[number];

export type FeedbackFindingInput = {
  classification: FeedbackClassification;
  component_kind: FeedbackComponentKind;
  component_id: string;
  operation?: string;
  error_category?: string;
  component_version?: string;
  user_goal: string;
  expected: string;
  observed: string;
  workaround?: string;
  evidence_summary?: string;
  normalized_goal?: string;
  normalized_gap?: string;
  normalized_outcome?: string;
};

export type ComponentProvenance = {
  componentKind?: FeedbackComponentKind;
  componentId: string;
  repository: string;
  source: "package-manifest" | "local-map";
};

export type FeedbackComponent = {
  kind: FeedbackComponentKind;
  id: string;
  operation?: string;
  errorCategory?: string;
  version?: string;
};

export type FeedbackFinding = {
  version: typeof SESSION_FEEDBACK_VERSION;
  id: string;
  createdAt: string;
  updatedAt: string;
  sessionFingerprint: string;
  classification: FeedbackClassification;
  component: FeedbackComponent;
  repository?: string;
  provenanceSource?: ComponentProvenance["source"];
  userGoal: string;
  expected: string;
  observed: string;
  workaround?: string;
  evidenceSummary?: string;
  normalizedGoal: string;
  normalizedGap: string;
  normalizedOutcome: string;
  disposition: "active" | "dismissed" | "suppressed";
  clusterId?: string;
};

export type IssueDraft = {
  title: string;
  body: string;
  updatedAt: string;
};

export type IssueLink = { number: number; url: string; linkedAt: string };
export type IssueSearchResult = { number: number; title: string; url: string; state: string };

export type FeedbackClusterState =
  | "tracking"
  | "ready-for-review"
  | "manually-promoted"
  | "linked-existing"
  | "submitted"
  | "dismissed";

export type FeedbackCluster = {
  version: typeof SESSION_FEEDBACK_VERSION;
  id: string;
  createdAt: string;
  updatedAt: string;
  repository: string;
  component: FeedbackComponent;
  classification: FeedbackClassification;
  findingIds: string[];
  state: FeedbackClusterState;
  manuallyPromoted?: boolean;
  matchReasons: string[];
  anchor: {
    userGoal: string;
    gap: string;
    outcome: string;
  };
  draft?: IssueDraft;
  linkedIssue?: IssueLink;
  submittedIssue?: IssueLink;
  lastSearch?: { searchedAt: string; results: IssueSearchResult[] };
  outboundDiagnostic?: "auth-unavailable" | "repository-unavailable" | "transport-failed";
};

export type FeedbackSuppression = {
  classification: FeedbackClassification;
  componentId?: string;
  repository?: string;
  createdAt: string;
};

type FeedbackStoreState = {
  version: typeof SESSION_FEEDBACK_VERSION;
  findings: FeedbackFinding[];
  clusters: FeedbackCluster[];
  suppressions: FeedbackSuppression[];
};

export type FeedbackSummary = {
  findings: number;
  localOnly: number;
  insufficient: number;
  tracking: number;
  readyForReview: number;
  linked: number;
  submitted: number;
};

export type FeedbackReport = FeedbackSummary & {
  sessionFingerprint: string;
  findingsForSession: Array<Pick<FeedbackFinding,
    "id" | "classification" | "component" | "repository" | "disposition" | "clusterId" | "createdAt"
  >>;
};

export type FeedbackClusterSummary = {
  id: string;
  state: FeedbackClusterState;
  repository: string;
  componentId: string;
  classification: FeedbackClassification;
  observationCount: number;
  independentSessionCount: number;
  title: string;
};

export type CommandResult = { status: number; stdout: string; stderr: string };
export type CommandRunner = (argv: string[], cwd: string, timeoutMs?: number) => CommandResult;

export type FeedbackStoreOptions = {
  env?: NodeJS.ProcessEnv;
  provenance?: ComponentProvenance[];
  now?: () => Date;
  runner?: CommandRunner;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function atomicJson(path: string, value: unknown): void {
  ensurePrivateDir(dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function sha(value: string, length = 24): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function isClassification(value: unknown): value is FeedbackClassification {
  return typeof value === "string" && (FEEDBACK_CLASSIFICATIONS as readonly string[]).includes(value);
}

function isComponentKind(value: unknown): value is FeedbackComponentKind {
  return typeof value === "string" && (FEEDBACK_COMPONENT_KINDS as readonly string[]).includes(value);
}

function stripTerminalControls(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\x1B\][\s\S]*?(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B[P^_][\s\S]*?\x1B\\/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B[()][0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "");
}

/** Bound and redact model-provided text before it enters durable feedback state. */
export function sanitizeFeedbackText(value: unknown, max = MAX_TEXT): string | undefined {
  if (typeof value !== "string") return undefined;
  let result = stripTerminalControls(value)
    .replace(/[^\S\r\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!result) return undefined;
  result = result
    .replace(/\b(?:gh[pous]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|sk-[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{12,})\b/g, "[redacted credential]")
    .replace(/\bauthorization\s*:\s*(?:bearer\s+)?[^\s,;]+/gi, "authorization: [redacted]")
    .replace(/\b(?:api[ _-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, (match) => `${match.split(/[:=]/, 1)[0] ?? "secret"}: [redacted]`)
    .replace(/(?:file:\/\/)?(?:\/(?:home|Users|tmp|var|private|workspace)\/[^\s,;"')]+|[A-Za-z]:\\(?:Users|home)\\[^\s,;"')]+)/g, "[redacted path]");
  if (/\[(?:user|assistant|tool(?: result)?)\]\s*:/i.test(result) || /(?:raw )?conversation (?:quote|transcript)/i.test(result)) {
    result = "[redacted session excerpt]";
  }
  return result.length > max ? result.slice(0, max).trimEnd() : result;
}

function sanitizeSingleLine(value: unknown, max: number): string | undefined {
  return sanitizeFeedbackText(value, max)?.replace(/\s+/g, " ").trim();
}

function safeIdentifier(value: unknown, max = 120): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > max || !/^[A-Za-z0-9@._/:-]+$/.test(normalized)) return undefined;
  return normalized;
}

function normalizeRepository(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim()
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "");
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized) ? normalized : undefined;
}

function normalizedText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/\[redacted[^\]]*\]/gi, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 40)
    .join(" ");
}

function textSet(value: string): Set<string> {
  return new Set(normalizedText(value).split(" ").filter((token) => token.length >= 2));
}

function compatibleText(left: string, right: string): boolean {
  const leftNormalized = normalizedText(left);
  const rightNormalized = normalizedText(right);
  if (!leftNormalized || !rightNormalized) return false;
  if (leftNormalized === rightNormalized || leftNormalized.includes(rightNormalized) || rightNormalized.includes(leftNormalized)) return true;
  const a = textSet(leftNormalized);
  const b = textSet(rightNormalized);
  if (a.size === 0 || b.size === 0) return false;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.max(a.size, b.size) >= 0.6;
}

function classificationFamily(value: FeedbackClassification): "structured" | "experience" | "feature" | "local" {
  if (value === "upstream-bug") return "structured";
  if (value === "documentation-gap" || value === "ux-friction") return "experience";
  if (value === "feature-request") return "feature";
  return "local";
}

function upstreamEligible(value: FeedbackClassification): boolean {
  return value === "upstream-bug" || value === "documentation-gap" || value === "ux-friction" || value === "feature-request";
}

function defaultState(): FeedbackStoreState {
  return { version: SESSION_FEEDBACK_VERSION, findings: [], clusters: [], suppressions: [] };
}

function validIssueUrl(repository: string, value: unknown): IssueLink | undefined {
  if (typeof value !== "string") return undefined;
  const match = new RegExp(`^https://github\\.com/${repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/issues/([1-9][0-9]*)$`).exec(value.trim());
  if (!match) return undefined;
  return { number: Number(match[1]), url: value.trim(), linkedAt: new Date().toISOString() };
}

/**
 * Validates and minimizes a model-provided feedback finding. Unknown fields are
 * intentionally ignored so raw-model output never becomes durable state.
 */
export function validateFeedbackFinding(value: unknown): FeedbackFindingInput | undefined {
  if (!isRecord(value) || !isClassification(value.classification) || !isComponentKind(value.component_kind)) return undefined;
  const componentId = safeIdentifier(value.component_id);
  const userGoal = sanitizeFeedbackText(value.user_goal);
  const expected = sanitizeFeedbackText(value.expected);
  const observed = sanitizeFeedbackText(value.observed);
  if (!componentId || !userGoal || !expected || !observed) return undefined;
  const operation = safeIdentifier(value.operation, 80);
  const errorCategory = safeIdentifier(value.error_category, 80);
  const componentVersion = safeIdentifier(value.component_version, 80);
  const workaround = sanitizeFeedbackText(value.workaround);
  const evidenceSummary = sanitizeFeedbackText(value.evidence_summary, MAX_EVIDENCE);
  const normalizedGoal = sanitizeFeedbackText(value.normalized_goal, 240);
  const normalizedGap = sanitizeFeedbackText(value.normalized_gap, 240);
  const normalizedOutcome = sanitizeFeedbackText(value.normalized_outcome, 240);
  return {
    classification: value.classification,
    component_kind: value.component_kind,
    component_id: componentId,
    ...(operation ? { operation } : {}),
    ...(errorCategory ? { error_category: errorCategory } : {}),
    ...(componentVersion ? { component_version: componentVersion } : {}),
    user_goal: userGoal,
    expected,
    observed,
    ...(workaround ? { workaround } : {}),
    ...(evidenceSummary ? { evidence_summary: evidenceSummary } : {}),
    ...(normalizedGoal ? { normalized_goal: normalizedGoal } : {}),
    ...(normalizedGap ? { normalized_gap: normalizedGap } : {}),
    ...(normalizedOutcome ? { normalized_outcome: normalizedOutcome } : {}),
  };
}

/** An opaque stable key; callers must never persist the raw session source. */
export function feedbackSessionFingerprint(cwd: string, sessionSource: string): string {
  return sha(`${resolve(cwd)}\u0000${sessionSource}`, 32);
}

export function defaultFeedbackProvenance(repository?: string): ComponentProvenance[] {
  const normalized = normalizeRepository(repository);
  if (!normalized) return [];
  return [
    { componentKind: "package", componentId: "agent-shared-knowledge", repository: normalized, source: "package-manifest" },
    { componentKind: "extension", componentId: "shared-knowledge-lifecycle", repository: normalized, source: "package-manifest" },
  ];
}

/**
 * An operator may explicitly map an installed component to a repository without
 * granting model output authority to choose a destination. Example:
 * [{"component_kind":"skill","component_id":"my-skill","repository":"owner/repo"}]
 */
export function parseFeedbackProvenance(env: NodeJS.ProcessEnv = process.env): ComponentProvenance[] {
  const raw = env[FEEDBACK_PROVENANCE_ENV];
  if (!raw || Buffer.byteLength(raw) > 16_384) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 64).flatMap((value) => {
      if (!isRecord(value)) return [];
      const componentId = safeIdentifier(value.component_id ?? value.componentId);
      const componentKind = value.component_kind ?? value.componentKind;
      const repository = normalizeRepository(value.repository);
      if (!componentId || !repository || (componentKind !== undefined && !isComponentKind(componentKind))) return [];
      return [{
        componentId,
        ...(componentKind ? { componentKind } : {}),
        repository,
        source: "local-map" as const,
      }];
    });
  } catch {
    return [];
  }
}

function safeCommandRunner(argv: string[], cwd: string, timeoutMs = 30_000): CommandResult {
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

function safeSearchResult(value: unknown, repository: string): IssueSearchResult | undefined {
  if (!isRecord(value) || !Number.isSafeInteger(value.number) || Number(value.number) < 1) return undefined;
  const url = validIssueUrl(repository, value.url);
  const title = sanitizeSingleLine(value.title, 240);
  const state = safeIdentifier(value.state, 32);
  if (!url || !title || !state) return undefined;
  return { number: url.number, url: url.url, title, state };
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function clusterTitle(cluster: FeedbackCluster): string {
  return `${cluster.component.id} · ${cluster.classification}`;
}

export class SessionFeedbackStore {
  readonly root: string;
  private readonly statePath: string;
  private readonly lockPath: string;
  private readonly provenance: ComponentProvenance[];
  private readonly now: () => Date;
  private readonly runner: CommandRunner;

  constructor(readonly cwd: string, options: FeedbackStoreOptions = {}) {
    this.root = join(resolveRuntimeRoot(cwd, options.env), "feedback");
    this.statePath = join(this.root, "state.json");
    this.lockPath = join(this.root, "state.lock");
    this.provenance = [...parseFeedbackProvenance(options.env), ...(options.provenance ?? [])];
    this.now = options.now ?? (() => new Date());
    this.runner = options.runner ?? safeCommandRunner;
  }

  /** Parse but do not create a private directory for a passive read. */
  private readState(): FeedbackStoreState {
    if (!existsSync(this.statePath)) return defaultState();
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as unknown;
      if (!isRecord(parsed) || parsed.version !== SESSION_FEEDBACK_VERSION || !Array.isArray(parsed.findings) || !Array.isArray(parsed.clusters) || !Array.isArray(parsed.suppressions)) {
        return defaultState();
      }
      return {
        version: SESSION_FEEDBACK_VERSION,
        findings: parsed.findings.filter((value): value is FeedbackFinding => isRecord(value) && typeof value.id === "string" && typeof value.sessionFingerprint === "string" && isClassification(value.classification)),
        clusters: parsed.clusters.filter((value): value is FeedbackCluster => isRecord(value) && typeof value.id === "string" && typeof value.repository === "string" && typeof value.state === "string"),
        suppressions: parsed.suppressions.filter((value): value is FeedbackSuppression => isRecord(value) && isClassification(value.classification)),
      };
    } catch {
      return defaultState();
    }
  }

  private writeState(state: FeedbackStoreState): void {
    atomicJson(this.statePath, state);
  }

  private withLock<T>(action: () => T): T {
    ensurePrivateDir(this.root);
    const nonce = randomUUID();
    let fd: number | undefined;
    try {
      fd = openSync(this.lockPath, "wx", 0o600);
      writeFileSync(fd, `${JSON.stringify({ nonce, pid: process.pid, createdAt: nowIso(this.now) })}\n`, "utf8");
      closeSync(fd);
      fd = undefined;
      chmodSync(this.lockPath, 0o600);
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" && this.reclaimStaleLock()) return this.withLock(action);
      throw new Error("feedback store is busy");
    }
    try {
      return action();
    } finally {
      try {
        const raw = JSON.parse(readFileSync(this.lockPath, "utf8")) as unknown;
        if (isRecord(raw) && raw.nonce === nonce) unlinkSync(this.lockPath);
      } catch {
        // A later bounded stale-lock recovery owns leftovers.
      }
    }
  }

  private reclaimStaleLock(): boolean {
    try {
      const info = lstatSync(this.lockPath);
      if (Date.now() - info.mtimeMs < LOCK_STALE_MS) return false;
      unlinkSync(this.lockPath);
      return true;
    } catch {
      return false;
    }
  }

  private resolveProvenance(component: FeedbackComponent): ComponentProvenance | undefined {
    return this.provenance.find((entry) =>
      entry.componentId === component.id
      && (!entry.componentKind || entry.componentKind === component.kind)
      && Boolean(normalizeRepository(entry.repository)),
    );
  }

  private isSuppressed(state: FeedbackStoreState, finding: Pick<FeedbackFinding, "classification" | "component" | "repository">): boolean {
    return state.suppressions.some((suppression) =>
      suppression.classification === finding.classification
      && (!suppression.componentId || suppression.componentId === finding.component.id)
      && (!suppression.repository || suppression.repository === finding.repository),
    );
  }

  private makeFinding(sessionSource: string, input: FeedbackFindingInput, state: FeedbackStoreState): FeedbackFinding {
    const sessionFingerprint = feedbackSessionFingerprint(this.cwd, sessionSource);
    const component: FeedbackComponent = {
      kind: input.component_kind,
      id: input.component_id,
      ...(input.operation ? { operation: input.operation } : {}),
      ...(input.error_category ? { errorCategory: input.error_category } : {}),
      ...(input.component_version ? { version: input.component_version } : {}),
    };
    const provenance = this.resolveProvenance(component);
    const repository = provenance ? normalizeRepository(provenance.repository) : undefined;
    const classification = upstreamEligible(input.classification) && !repository ? "unresolved-owner" : input.classification;
    const stamp = nowIso(this.now);
    const normalizedGoal = normalizedText(input.normalized_goal ?? input.user_goal);
    const normalizedGap = normalizedText(input.normalized_gap ?? `${input.expected} ${input.observed}`);
    const normalizedOutcome = normalizedText(input.normalized_outcome ?? input.workaround ?? input.observed);
    const id = sha(JSON.stringify({
      sessionFingerprint,
      classification,
      component,
      normalizedGoal,
      normalizedGap,
      normalizedOutcome,
    }));
    const finding: FeedbackFinding = {
      version: SESSION_FEEDBACK_VERSION,
      id,
      createdAt: stamp,
      updatedAt: stamp,
      sessionFingerprint,
      classification,
      component,
      ...(repository ? { repository } : {}),
      ...(provenance ? { provenanceSource: provenance.source } : {}),
      userGoal: input.user_goal,
      expected: input.expected,
      observed: input.observed,
      ...(input.workaround ? { workaround: input.workaround } : {}),
      ...(input.evidence_summary ? { evidenceSummary: input.evidence_summary } : {}),
      normalizedGoal,
      normalizedGap,
      normalizedOutcome,
      disposition: "active",
    };
    if (this.isSuppressed(state, finding)) finding.disposition = "suppressed";
    return finding;
  }

  private clusterFor(state: FeedbackStoreState, finding: FeedbackFinding): FeedbackCluster | undefined {
    if (!finding.repository || !upstreamEligible(finding.classification) || finding.disposition !== "active") return undefined;
    return state.clusters.find((cluster) => cluster.state !== "dismissed" && this.compatible(cluster, finding));
  }

  private compatible(cluster: FeedbackCluster, finding: FeedbackFinding): boolean {
    if (cluster.repository !== finding.repository || cluster.component.kind !== finding.component.kind || cluster.component.id !== finding.component.id) return false;
    const family = classificationFamily(cluster.classification);
    if (family !== classificationFamily(finding.classification)) return false;
    if (family === "structured") {
      if (!cluster.component.operation || !finding.component.operation || cluster.component.operation !== finding.component.operation) return false;
      if (!cluster.component.errorCategory || !finding.component.errorCategory || cluster.component.errorCategory !== finding.component.errorCategory) return false;
      if (cluster.component.version && finding.component.version && cluster.component.version !== finding.component.version) return false;
      return true;
    }
    return compatibleText(cluster.anchor.userGoal, finding.normalizedGoal)
      && compatibleText(cluster.anchor.gap, finding.normalizedGap)
      && compatibleText(cluster.anchor.outcome, finding.normalizedOutcome);
  }

  private createCluster(finding: FeedbackFinding): FeedbackCluster {
    const stamp = nowIso(this.now);
    const id = sha(JSON.stringify({
      repository: finding.repository,
      component: finding.component,
      classification: classificationFamily(finding.classification),
      goal: finding.normalizedGoal,
      gap: finding.normalizedGap,
      outcome: finding.normalizedOutcome,
    }));
    return {
      version: SESSION_FEEDBACK_VERSION,
      id,
      createdAt: stamp,
      updatedAt: stamp,
      repository: finding.repository!,
      component: { ...finding.component },
      classification: finding.classification,
      findingIds: [finding.id],
      state: "tracking",
      matchReasons: ["same trusted repository", "same component", "new cluster anchor"],
      anchor: {
        userGoal: finding.normalizedGoal,
        gap: finding.normalizedGap,
        outcome: finding.normalizedOutcome,
      },
    };
  }

  private attachFinding(state: FeedbackStoreState, finding: FeedbackFinding): void {
    const existing = this.clusterFor(state, finding);
    const cluster = existing ?? this.createCluster(finding);
    if (!existing) state.clusters.push(cluster);
    if (!cluster.findingIds.includes(finding.id)) cluster.findingIds.push(finding.id);
    finding.clusterId = cluster.id;
    cluster.updatedAt = nowIso(this.now);
    if (existing) {
      const reasons = ["same trusted repository", "same component", "same classification family"];
      if (classificationFamily(finding.classification) === "structured") reasons.push("same operation and error category");
      else reasons.push("compatible goal, gap, and outcome");
      cluster.matchReasons = reasons;
    }
    this.refreshCluster(state, cluster);
  }

  private refreshCluster(state: FeedbackStoreState, cluster: FeedbackCluster): void {
    const findings = cluster.findingIds
      .map((id) => state.findings.find((finding) => finding.id === id))
      .filter((finding): finding is FeedbackFinding => finding !== undefined && finding.disposition === "active");
    cluster.findingIds = findings.map((finding) => finding.id);
    if (cluster.findingIds.length === 0) {
      cluster.state = "dismissed";
      cluster.updatedAt = nowIso(this.now);
      return;
    }
    if (cluster.state === "dismissed" || cluster.state === "linked-existing" || cluster.state === "submitted" || cluster.state === "manually-promoted") return;
    const latest = Math.max(...findings.map((finding) => Date.parse(finding.createdAt)).filter(Number.isFinite));
    const fingerprints = new Set(findings
      .filter((finding) => latest - Date.parse(finding.createdAt) <= FEEDBACK_EVIDENCE_WINDOW_MS)
      .map((finding) => finding.sessionFingerprint));
    if (fingerprints.size >= 2) {
      cluster.state = "ready-for-review";
      cluster.draft = this.buildDraft(cluster, findings, false);
    } else {
      cluster.state = "tracking";
      cluster.draft = undefined;
    }
    cluster.updatedAt = nowIso(this.now);
  }

  private buildDraft(cluster: FeedbackCluster, findings: FeedbackFinding[], manuallyPromoted: boolean): IssueDraft {
    const representative = findings[0];
    const count = new Set(findings.map((finding) => finding.sessionFingerprint)).size;
    const title = sanitizeSingleLine(`${cluster.component.id}: ${representative?.observed ?? cluster.classification}`, 120)
      ?? `${cluster.component.id}: ${cluster.classification}`;
    const lines = [
      "## Summary",
      representative?.observed ?? "Observed workflow friction.",
      "",
      "## Context",
      `Component: ${cluster.component.id}`,
      `Classification: ${cluster.classification}`,
      manuallyPromoted
        ? "Evidence: manually promoted by the local operator."
        : `Evidence: observed in ${count} independent local sessions within ${FEEDBACK_EVIDENCE_WINDOW_DAYS} days.`,
      "",
      "## Expected behavior",
      representative?.expected ?? "The documented workflow should complete predictably.",
      "",
      "## Actual behavior",
      representative?.observed ?? "The workflow did not complete as expected.",
    ];
    if (representative?.workaround) lines.push("", "## Workaround", representative.workaround);
    return {
      title,
      body: sanitizeFeedbackText(lines.join("\n"), 8_000) ?? "",
      updatedAt: nowIso(this.now),
    };
  }

  ingest(sessionSource: string, inputs: unknown[]): { findings: FeedbackFinding[]; summary: FeedbackSummary } {
    if (!sessionSource || !Array.isArray(inputs)) return { findings: [], summary: this.summary() };
    return this.withLock(() => {
      const state = this.readState();
      const accepted: FeedbackFinding[] = [];
      for (const raw of inputs.slice(0, MAX_FINDINGS_PER_INGEST)) {
        if (state.findings.length >= MAX_FINDINGS_TOTAL) break;
        const validated = validateFeedbackFinding(raw);
        if (!validated) continue;
        const finding = this.makeFinding(sessionSource, validated, state);
        const existing = state.findings.find((candidate) => candidate.id === finding.id);
        if (existing) {
          accepted.push(existing);
          continue;
        }
        state.findings.push(finding);
        if (finding.repository && upstreamEligible(finding.classification) && finding.disposition === "active") this.attachFinding(state, finding);
        accepted.push(finding);
      }
      for (const cluster of state.clusters) this.refreshCluster(state, cluster);
      state.clusters = state.clusters.filter((cluster) => cluster.findingIds.length > 0).slice(0, MAX_CLUSTERS_TOTAL);
      this.writeState(state);
      return { findings: accepted, summary: this.summaryFrom(state) };
    });
  }

  summary(): FeedbackSummary {
    return this.summaryFrom(this.readState());
  }

  private summaryFrom(state: FeedbackStoreState): FeedbackSummary {
    const clusters = state.clusters;
    return {
      findings: state.findings.length,
      localOnly: state.findings.filter((finding) => ["local-configuration", "agent-behavior", "unresolved-owner"].includes(finding.classification)).length,
      insufficient: state.findings.filter((finding) => finding.classification === "insufficient-evidence").length,
      tracking: clusters.filter((cluster) => cluster.state === "tracking").length,
      readyForReview: clusters.filter((cluster) => cluster.state === "ready-for-review" || cluster.state === "manually-promoted").length,
      linked: clusters.filter((cluster) => cluster.state === "linked-existing").length,
      submitted: clusters.filter((cluster) => cluster.state === "submitted").length,
    };
  }

  report(sessionSource: string): FeedbackReport {
    const state = this.readState();
    const sessionFingerprint = feedbackSessionFingerprint(this.cwd, sessionSource);
    const findings = state.findings.filter((finding) => finding.sessionFingerprint === sessionFingerprint);
    return {
      ...this.summaryFrom(state),
      sessionFingerprint,
      findingsForSession: findings.map((finding) => ({
        id: finding.id,
        classification: finding.classification,
        component: { ...finding.component },
        ...(finding.repository ? { repository: finding.repository } : {}),
        disposition: finding.disposition,
        ...(finding.clusterId ? { clusterId: finding.clusterId } : {}),
        createdAt: finding.createdAt,
      })),
    };
  }

  finding(id: string): FeedbackFinding | undefined {
    return this.readState().findings.find((finding) => finding.id === id);
  }

  cluster(id: string): FeedbackCluster | undefined {
    return this.readState().clusters.find((cluster) => cluster.id === id);
  }

  queue(): FeedbackClusterSummary[] {
    const state = this.readState();
    return state.clusters
      .filter((cluster) => cluster.state !== "dismissed")
      .map((cluster) => {
        const fingerprints = new Set(cluster.findingIds
          .map((id) => state.findings.find((finding) => finding.id === id)?.sessionFingerprint)
          .filter((value): value is string => Boolean(value)));
        return {
          id: cluster.id,
          state: cluster.state,
          repository: cluster.repository,
          componentId: cluster.component.id,
          classification: cluster.classification,
          observationCount: cluster.findingIds.length,
          independentSessionCount: fingerprints.size,
          title: clusterTitle(cluster),
        };
      })
      .sort((left, right) => right.independentSessionCount - left.independentSessionCount || left.title.localeCompare(right.title));
  }

  dismissFinding(id: string): boolean {
    return this.withLock(() => {
      const state = this.readState();
      const finding = state.findings.find((candidate) => candidate.id === id);
      if (!finding) return false;
      finding.disposition = "dismissed";
      finding.updatedAt = nowIso(this.now);
      if (finding.clusterId) {
        const cluster = state.clusters.find((candidate) => candidate.id === finding.clusterId);
        if (cluster) this.refreshCluster(state, cluster);
      }
      this.writeState(state);
      return true;
    });
  }

  removeFinding(id: string): boolean {
    return this.withLock(() => {
      const state = this.readState();
      const index = state.findings.findIndex((finding) => finding.id === id);
      if (index < 0) return false;
      const [removed] = state.findings.splice(index, 1);
      for (const cluster of state.clusters) {
        cluster.findingIds = cluster.findingIds.filter((findingId) => findingId !== removed.id);
        this.refreshCluster(state, cluster);
      }
      state.clusters = state.clusters.filter((cluster) => cluster.findingIds.length > 0);
      this.writeState(state);
      return true;
    });
  }

  purgeSession(sessionSource: string): number {
    const fingerprint = feedbackSessionFingerprint(this.cwd, sessionSource);
    return this.withLock(() => {
      const state = this.readState();
      const removed = state.findings.filter((finding) => finding.sessionFingerprint === fingerprint).map((finding) => finding.id);
      if (!removed.length) return 0;
      state.findings = state.findings.filter((finding) => !removed.includes(finding.id));
      for (const cluster of state.clusters) {
        cluster.findingIds = cluster.findingIds.filter((id) => !removed.includes(id));
        this.refreshCluster(state, cluster);
      }
      state.clusters = state.clusters.filter((cluster) => cluster.findingIds.length > 0);
      this.writeState(state);
      return removed.length;
    });
  }

  suppress(classification: FeedbackClassification, componentId?: string, repository?: string): boolean {
    const safeComponent = componentId ? safeIdentifier(componentId) : undefined;
    const safeRepository = repository ? normalizeRepository(repository) : undefined;
    return this.withLock(() => {
      const state = this.readState();
      if (!state.suppressions.some((value) => value.classification === classification && value.componentId === safeComponent && value.repository === safeRepository)) {
        state.suppressions.push({ classification, ...(safeComponent ? { componentId: safeComponent } : {}), ...(safeRepository ? { repository: safeRepository } : {}), createdAt: nowIso(this.now) });
      }
      for (const finding of state.findings) {
        if (this.isSuppressed(state, finding)) {
          finding.disposition = "suppressed";
          finding.updatedAt = nowIso(this.now);
        }
      }
      for (const cluster of state.clusters) this.refreshCluster(state, cluster);
      this.writeState(state);
      return true;
    });
  }

  splitCluster(id: string, findingIds: string[]): FeedbackCluster | undefined {
    return this.withLock(() => {
      const state = this.readState();
      const source = state.clusters.find((cluster) => cluster.id === id);
      const selected = [...new Set(findingIds)].filter((findingId) => source?.findingIds.includes(findingId));
      if (!source || selected.length === 0 || selected.length === source.findingIds.length) return undefined;
      const first = state.findings.find((finding) => finding.id === selected[0]);
      if (!first) return undefined;
      source.findingIds = source.findingIds.filter((findingId) => !selected.includes(findingId));
      this.refreshCluster(state, source);
      const next = this.createCluster(first);
      next.id = sha(`${id}\u0000split\u0000${selected.sort().join("\u0000")}`);
      next.findingIds = selected;
      next.matchReasons = ["manually split by local operator"];
      state.clusters.push(next);
      for (const findingId of selected) {
        const finding = state.findings.find((candidate) => candidate.id === findingId);
        if (finding) finding.clusterId = next.id;
      }
      this.refreshCluster(state, next);
      this.writeState(state);
      return next;
    });
  }

  dismissCluster(id: string): boolean {
    return this.withLock(() => {
      const state = this.readState();
      const cluster = state.clusters.find((candidate) => candidate.id === id);
      if (!cluster || cluster.state === "submitted") return false;
      cluster.state = "dismissed";
      cluster.updatedAt = nowIso(this.now);
      this.writeState(state);
      return true;
    });
  }

  manualPromote(id: string): FeedbackCluster | undefined {
    return this.withLock(() => {
      const state = this.readState();
      const cluster = state.clusters.find((candidate) => candidate.id === id);
      if (!cluster || !["tracking", "ready-for-review"].includes(cluster.state)) return undefined;
      const findings = cluster.findingIds
        .map((findingId) => state.findings.find((finding) => finding.id === findingId))
        .filter((finding): finding is FeedbackFinding => Boolean(finding));
      if (!findings.length) return undefined;
      cluster.state = "manually-promoted";
      cluster.manuallyPromoted = true;
      cluster.draft = this.buildDraft(cluster, findings, true);
      cluster.updatedAt = nowIso(this.now);
      this.writeState(state);
      return cluster;
    });
  }

  updateDraft(id: string, title: unknown, body: unknown): IssueDraft | undefined {
    return this.withLock(() => {
      const state = this.readState();
      const cluster = state.clusters.find((candidate) => candidate.id === id);
      if (!cluster || !["ready-for-review", "manually-promoted"].includes(cluster.state)) return undefined;
      const safeTitle = sanitizeSingleLine(title, 120);
      const safeBody = sanitizeFeedbackText(body, 8_000);
      if (!safeTitle || !safeBody) return undefined;
      cluster.draft = { title: safeTitle, body: safeBody, updatedAt: nowIso(this.now) };
      cluster.updatedAt = nowIso(this.now);
      this.writeState(state);
      return cluster.draft;
    });
  }

  linkExistingIssue(id: string, url: unknown): IssueLink | undefined {
    return this.withLock(() => {
      const state = this.readState();
      const cluster = state.clusters.find((candidate) => candidate.id === id);
      if (!cluster || !["ready-for-review", "manually-promoted"].includes(cluster.state)) return undefined;
      const link = validIssueUrl(cluster.repository, url);
      if (!link) return undefined;
      cluster.linkedIssue = link;
      cluster.state = "linked-existing";
      cluster.updatedAt = nowIso(this.now);
      this.writeState(state);
      return link;
    });
  }

  searchDuplicates(id: string): { status: "ok"; results: IssueSearchResult[] } | { status: "failed" } {
    const snapshot = this.cluster(id);
    if (!snapshot || !["ready-for-review", "manually-promoted"].includes(snapshot.state) || !snapshot.draft) return { status: "failed" };
    const result = this.runner([
      "gh", "issue", "list", "--repo", snapshot.repository, "--state", "open", "--limit", "20",
      "--search", snapshot.draft.title, "--json", "number,title,url,state",
    ], this.cwd, 30_000);
    if (result.status !== 0) {
      this.recordOutboundDiagnostic(id, "transport-failed");
      return { status: "failed" };
    }
    const parsed = parseJson(result.stdout);
    const entries = Array.isArray(parsed) ? parsed
      .map((value) => safeSearchResult(value, snapshot.repository))
      .filter((value): value is IssueSearchResult => Boolean(value))
      .slice(0, 20) : [];
    this.withLock(() => {
      const state = this.readState();
      const cluster = state.clusters.find((candidate) => candidate.id === id);
      if (!cluster) return;
      cluster.lastSearch = { searchedAt: nowIso(this.now), results: entries };
      cluster.outboundDiagnostic = undefined;
      cluster.updatedAt = nowIso(this.now);
      this.writeState(state);
    });
    return { status: "ok", results: entries };
  }

  submit(id: string): IssueLink | undefined {
    const snapshot = this.cluster(id);
    if (!snapshot || !["ready-for-review", "manually-promoted"].includes(snapshot.state) || !snapshot.draft) return undefined;
    const auth = this.runner(["gh", "auth", "status", "--hostname", "github.com"], this.cwd, 30_000);
    if (auth.status !== 0) {
      this.recordOutboundDiagnostic(id, "auth-unavailable");
      return undefined;
    }
    const result = this.runner([
      "gh", "issue", "create", "--repo", snapshot.repository,
      "--title", snapshot.draft.title,
      "--body", snapshot.draft.body,
    ], this.cwd, 60_000);
    if (result.status !== 0) {
      this.recordOutboundDiagnostic(id, "transport-failed");
      return undefined;
    }
    const link = validIssueUrl(snapshot.repository, result.stdout.trim());
    if (!link) {
      this.recordOutboundDiagnostic(id, "repository-unavailable");
      return undefined;
    }
    return this.withLock(() => {
      const state = this.readState();
      const cluster = state.clusters.find((candidate) => candidate.id === id);
      if (!cluster || !["ready-for-review", "manually-promoted"].includes(cluster.state)) return undefined;
      cluster.submittedIssue = link;
      cluster.state = "submitted";
      cluster.outboundDiagnostic = undefined;
      cluster.updatedAt = nowIso(this.now);
      this.writeState(state);
      return link;
    });
  }

  private recordOutboundDiagnostic(id: string, diagnostic: NonNullable<FeedbackCluster["outboundDiagnostic"]>): void {
    this.withLock(() => {
      const state = this.readState();
      const cluster = state.clusters.find((candidate) => candidate.id === id);
      if (!cluster) return;
      cluster.outboundDiagnostic = diagnostic;
      cluster.updatedAt = nowIso(this.now);
      this.writeState(state);
    });
  }
}
