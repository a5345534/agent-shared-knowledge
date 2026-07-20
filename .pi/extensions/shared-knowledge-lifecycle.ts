/** Checkout-safe, non-blocking shared-knowledge lifecycle integration for Pi. */
import { complete } from "@earendil-works/pi-ai/compat";
import { convertToLlm, getAgentDir, serializeConversation, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import {
  KnowledgeJobQueue,
  batchFollowerPatch,
  createCapturedPayload,
  createReviewResult,
  isMeaningfulConversation,
  normalizeConversation,
  parseQueueConfig,
  type KnowledgeJob,
} from "../../src/knowledge-job-runtime.ts";
import {
  inboxCandidateIdentity,
  materializeCandidates,
  materializeInboxCandidate,
  validateCandidate,
  type Candidate,
} from "../../src/pi-lifecycle-materializer.ts";
import {
  ReviewCandidateViewer,
  ReviewJobSelector,
  type ReviewUiAction,
} from "../../src/knowledge-review-ui.ts";
import {
  commandBinding,
  failedJobSummaries,
  formatMaterializerPolicy,
  formatModelPolicy,
  formatPublisherPolicy,
  formatSafeJobDiagnostic,
  globalConfigPath,
  materializerArgumentCompletions,
  modelArgumentCompletions,
  parseKnowledgeMaterializerArgs,
  parseKnowledgeModelArgs,
  parseKnowledgePublisherArgs,
  readConfig,
  requireMaterializerConfig,
  requireModelAuthentication,
  resolveEffectiveMaterializer,
  resolveEffectiveModel,
  resolveEffectivePublisher,
  selectExtractionModel,
  summarizeQueue,
  updateConfig,
  workspaceConfigPath,
  type ConfigScope,
  type MaterializerPolicy,
  type ModelPolicy,
  type PublisherPolicy,
} from "../../src/knowledge-config-runtime.ts";
import { KnowledgePublisherQueue, KnowledgePublisherRuntime } from "../../src/knowledge-publisher-runtime.ts";
import {
  CANDIDATE_SUBMISSION_TOOL_NAME,
  extractionFailureNotice,
  extractionRetryInstruction,
  parseCandidateAssistantResponse,
} from "../../src/candidate-response.ts";
import { defaultFeedbackProvenance, SessionFeedbackStore, sanitizeFeedbackText, type FeedbackReportFinding } from "../../src/session-feedback-runtime.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROMPT_FILE = join(PACKAGE_ROOT, ".pi", "prompts", "compact-review.md");
const ABSORBER_SCRIPT = join(PACKAGE_ROOT, "scripts", "knowledge_absorb.py");
const SOURCES_SCRIPT = join(PACKAGE_ROOT, "scripts", "knowledge_sources.py");
const LINT_SCRIPT = join(PACKAGE_ROOT, "scripts", "knowledge_lint.py");

function packageRepository(): string | undefined {
  try {
    const value = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as unknown;
    if (!value || typeof value !== "object") return undefined;
    const repository = (value as { repository?: unknown }).repository;
    if (typeof repository === "string") return repository;
    if (repository && typeof repository === "object" && typeof (repository as { url?: unknown }).url === "string") {
      return (repository as { url: string }).url;
    }
  } catch {
    // Unavailable metadata leaves the component unresolved and local-only.
  }
  return undefined;
}

const PACKAGE_REPOSITORY = packageRepository();
const running = new Set<string>();
const timers = new Map<string, NodeJS.Timeout>();
const busy = new Set<string>();
const CANDIDATE_SUBMISSION_TOOL = {
  name: CANDIDATE_SUBMISSION_TOOL_NAME,
  description: "Submit strictly structured durable shared-knowledge candidates and optional private session feedback findings.",
  parameters: Type.Object({
    candidates: Type.Array(Type.Object({
      name: Type.String({ minLength: 1, maxLength: 80 }),
      description: Type.String({ minLength: 1, maxLength: 180 }),
      type: Type.Union([
        Type.Literal("architectural-invariant"),
        Type.Literal("reference"),
        Type.Literal("project"),
        Type.Literal("feedback"),
      ]),
      suggested_scope: Type.String({ pattern: "^(workspace|module:[a-z0-9][a-z0-9-]*|capability:[a-z0-9][a-z0-9-]*)$" }),
      body: Type.String({ minLength: 20 }),
      reason: Type.String({ minLength: 1 }),
      candidate_id: Type.String({ minLength: 1 }),
      evidence: Type.Optional(Type.Array(Type.String())),
    })),
    // Optional feedback is independently validated and never blocks the
    // existing candidate path when absent or malformed.
    feedback_findings: Type.Optional(Type.Array(Type.Object({
      classification: Type.Union([
        Type.Literal("upstream-bug"),
        Type.Literal("documentation-gap"),
        Type.Literal("ux-friction"),
        Type.Literal("feature-request"),
        Type.Literal("local-configuration"),
        Type.Literal("agent-behavior"),
        Type.Literal("unresolved-owner"),
        Type.Literal("insufficient-evidence"),
      ]),
      component_kind: Type.Union([
        Type.Literal("extension"),
        Type.Literal("skill"),
        Type.Literal("package"),
        Type.Literal("pi-core"),
        Type.Literal("project"),
        Type.Literal("local"),
        Type.Literal("unknown"),
      ]),
      component_id: Type.String({ minLength: 1, maxLength: 120 }),
      user_goal: Type.String({ minLength: 1, maxLength: 1200 }),
      expected: Type.String({ minLength: 1, maxLength: 1200 }),
      observed: Type.String({ minLength: 1, maxLength: 1200 }),
      operation: Type.Optional(Type.String({ maxLength: 80 })),
      error_category: Type.Optional(Type.String({ maxLength: 80 })),
      component_version: Type.Optional(Type.String({ maxLength: 80 })),
      workaround: Type.Optional(Type.String({ maxLength: 1200 })),
      evidence_summary: Type.Optional(Type.String({ maxLength: 400 })),
      normalized_goal: Type.Optional(Type.String({ maxLength: 240 })),
      normalized_gap: Type.Optional(Type.String({ maxLength: 240 })),
      normalized_outcome: Type.Optional(Type.String({ maxLength: 240 })),
    }))),
  }),
};

function runAbsorber(cwd: string): Promise<void> {
  if (!existsSync(ABSORBER_SCRIPT)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [
      ABSORBER_SCRIPT, "--root", cwd, "hook", "--format", "json", "--git-mode", "none",
    ], { cwd, shell: false, stdio: "ignore", timeout: 60_000 });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`absorber exited ${code}`)));
  });
}

function runSourceAck(cwd: string, instanceId: string, runId: string): Promise<void> {
  if (!existsSync(SOURCES_SCRIPT)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [SOURCES_SCRIPT, "--root", cwd, "ack", instanceId, runId], {
      cwd, shell: false, stdio: "ignore", timeout: 30_000,
    });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`source ack exited ${code}`)));
  });
}

function promptText(): string {
  return existsSync(PROMPT_FILE)
    ? readFileSync(PROMPT_FILE, "utf8")
    : "Extract durable shared-knowledge candidates and optional private feedback findings as JSON with a candidates array.";
}

export default function sharedKnowledgeLifecycle(pi: ExtensionAPI) {
  const queues = new Map<string, KnowledgeJobQueue>();
  const feedbackStores = new Map<string, SessionFeedbackStore>();
  const feedbackSessionNonces = new Map<object | string, string>();
  const sessionModelPolicies = new Map<object | string, ModelPolicy>();
  const sessionMaterializerPolicies = new Map<object | string, MaterializerPolicy>();
  const sessionPublisherPolicies = new Map<object | string, PublisherPolicy>();
  const publisherQueues = new Map<string, KnowledgePublisherQueue>();
  const publisherRunning = new Set<string>();
  let availableModels: Array<{ provider: string; id: string }> = [];

  const queueFor = (cwd: string, recoverInterrupted = true) => {
    let queue = queues.get(cwd);
    if (!queue) {
      queue = new KnowledgeJobQueue(cwd);
      // Initial lifecycle acquisition recovers an interrupted prior process.
      // Explicit retry must not recover or mutate unrelated running jobs.
      if (recoverInterrupted) queue.recoverRunning();
      queues.set(cwd, queue);
    }
    return queue;
  };
  // Passive status/recovery views must never call recoverRunning().
  const viewQueueFor = (cwd: string) => queues.get(cwd) ?? new KnowledgeJobQueue(cwd);
  const feedbackStoreFor = (cwd: string) => {
    let store = feedbackStores.get(cwd);
    if (!store) {
      store = new SessionFeedbackStore(cwd, { provenance: defaultFeedbackProvenance(PACKAGE_REPOSITORY) });
      feedbackStores.set(cwd, store);
    }
    return store;
  };
  /**
   * Persisted sessions are fingerprinted from their private file source by the
   * feedback store. Unsaved sessions receive one opaque lifecycle nonce so
   * repeated compact segments do not masquerade as independent sessions.
   */
  const feedbackSessionSourceFor = (ctx: ExtensionContext): string => {
    const file = ctx.sessionManager.getSessionFile();
    if (file) return file;
    const key = ctx.sessionManager as object;
    let nonce = feedbackSessionNonces.get(key);
    if (!nonce) {
      nonce = randomUUID();
      feedbackSessionNonces.set(key, nonce);
    }
    return `memory:${nonce}`;
  };
  const sessionPolicyFor = <T,>(policies: Map<object | string, T>, ctx: ExtensionContext): T | undefined => {
    const direct = policies.get(ctx.sessionManager);
    const file = ctx.sessionManager.getSessionFile();
    return direct ?? (file ? policies.get(file) : undefined);
  };
  const updateSessionPolicy = <T,>(policies: Map<object | string, T>, ctx: ExtensionContext, policy?: T) => {
    const file = ctx.sessionManager.getSessionFile();
    if (policy) {
      policies.set(ctx.sessionManager, policy);
      if (file) policies.set(file, policy);
    } else {
      policies.delete(ctx.sessionManager);
      if (file) policies.delete(file);
    }
  };
  const persistentConfigFor = (ctx: ExtensionContext) => ({
    workspace: readConfig(workspaceConfigPath(ctx.cwd)),
    global: readConfig(globalConfigPath(getAgentDir())),
  });
  const effectiveModelFor = (ctx: ExtensionContext) => {
    const config = persistentConfigFor(ctx);
    return resolveEffectiveModel({
      session: sessionPolicyFor(sessionModelPolicies, ctx),
      workspace: config.workspace,
      global: config.global,
    });
  };
  const effectiveMaterializerFor = (ctx: ExtensionContext) => {
    const config = persistentConfigFor(ctx);
    return resolveEffectiveMaterializer({
      session: sessionPolicyFor(sessionMaterializerPolicies, ctx),
      workspace: config.workspace,
      global: config.global,
    });
  };
  const effectivePublisherFor = (ctx: ExtensionContext) => {
    const config = persistentConfigFor(ctx);
    return resolveEffectivePublisher({
      session: sessionPolicyFor(sessionPublisherPolicies, ctx),
      workspace: config.workspace,
      global: config.global,
    });
  };
  const publisherQueueFor = (cwd: string) => {
    let queue = publisherQueues.get(cwd);
    if (!queue) {
      queue = new KnowledgePublisherQueue(cwd);
      publisherQueues.set(cwd, queue);
    }
    return queue;
  };
  const refreshAvailableModels = (ctx: ExtensionContext) => {
    availableModels = ctx.modelRegistry.getAvailable().map((model) => ({ provider: model.provider, id: model.id }));
    return availableModels;
  };
  const scopedPath = (ctx: ExtensionContext, scope: Exclude<ConfigScope, "session">) => {
    return scope === "workspace" ? workspaceConfigPath(ctx.cwd) : globalConfigPath(getAgentDir());
  };
  const updateModelScope = (ctx: ExtensionContext, scope: ConfigScope, policy?: ModelPolicy) => {
    if (scope === "session") return updateSessionPolicy(sessionModelPolicies, ctx, policy);
    updateConfig(scopedPath(ctx, scope), { extractionModel: policy ?? null });
  };
  const updateMaterializerScope = (ctx: ExtensionContext, scope: ConfigScope, policy?: MaterializerPolicy) => {
    if (scope === "session") return updateSessionPolicy(sessionMaterializerPolicies, ctx, policy);
    updateConfig(scopedPath(ctx, scope), { materializer: policy ?? null });
  };
  const updatePublisherScope = (ctx: ExtensionContext, scope: ConfigScope, policy?: PublisherPolicy) => {
    if (policy?.mode === "auto-merge" && scope === "global") throw new Error("auto-merge cannot be configured globally");
    if (scope === "session") return updateSessionPolicy(sessionPublisherPolicies, ctx, policy);
    updateConfig(scopedPath(ctx, scope), { publisher: policy ?? null });
  };
  const permitInactiveModelWrite = async (ctx: ExtensionContext, allowInactive: boolean, interactive: boolean) => {
    const effective = effectiveModelFor(ctx);
    if (!effective.locked) return true;
    if (allowInactive) return true;
    if (interactive) {
      return ctx.ui.confirm(
        "Environment lock is active",
        "This lower-scope value will remain inactive until SHARED_KNOWLEDGE_EXTRACTION_MODEL is unset. Save it anyway?",
      );
    }
    throw new Error("environment override is locked; pass --allow-inactive to change a lower scope");
  };
  const statusText = (ctx: ExtensionContext) => {
    const model = effectiveModelFor(ctx);
    const materializer = effectiveMaterializerFor(ctx);
    const publisher = effectivePublisherFor(ctx);
    const queue = viewQueueFor(ctx.cwd);
    const publishJobs = publisherQueueFor(ctx.cwd).summaries();
    const feedback = feedbackStoreFor(ctx.cwd).summary();
    const counts = summarizeQueue(queue.list());
    const configuredModel = model.policy ? formatModelPolicy(model.policy) : "invalid environment value";
    const activeDetail = model.policy?.mode === "active"
      ? ` → ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no active model"}`
      : "";
    const configuredMaterializer = materializer.policy ? formatMaterializerPolicy(materializer.policy) : "invalid";
    const configuredPublisher = publisher.policy ? formatPublisherPolicy(publisher.policy) : "invalid";
    const publishCounts = publishJobs.reduce<Record<string, number>>((counts, job) => {
      counts[job.state] = (counts[job.state] ?? 0) + 1;
      return counts;
    }, {});
    return [
      `Extraction model: ${configuredModel}${activeDetail}`,
      `Source: ${model.source}${model.locked ? " (locked by environment)" : ""}`,
      model.error ? `Model configuration error: ${model.error.slice(0, 240)}` : undefined,
      `Materializer: ${configuredMaterializer}`,
      `Materializer source: ${materializer.source}`,
      materializer.policy?.mode === "command" ? `Command binding: ${materializer.commandBindingAvailable ? "available" : "unavailable"}` : undefined,
      materializer.error ? "Materializer configuration error" : undefined,
      `Publisher: ${configuredPublisher}`,
      `Publisher source: ${publisher.source}${publisher.locked ? " (locked by environment)" : ""}`,
      publisher.error ? "Publisher configuration error" : undefined,
      `Publisher jobs: ${Object.entries(publishCounts).map(([state, count]) => `${state}=${count}`).join(" ") || "none"}`,
      `Runtime: ${queue.root}`,
      `Jobs: pending=${counts.pending} running=${counts.running} retry-wait=${counts["retry-wait"]} failed=${counts.failed} review-ready=${counts["review-ready"]}`,
      `Feedback: findings=${feedback.findings} local-only=${feedback.localOnly} tracking=${feedback.tracking} ready=${feedback.readyForReview} linked=${feedback.linked} submitted=${feedback.submitted}`,
      ...model.diagnostics.map((diagnostic) => `Warning: ${diagnostic}`),
      ...materializer.diagnostics.map((diagnostic) => `Warning: ${diagnostic}`),
      ...publisher.diagnostics.map((diagnostic) => `Warning: ${diagnostic}`),
    ].filter((line): line is string => Boolean(line)).join("\n");
  };
  const showStatus = (ctx: ExtensionContext) => ctx.ui.notify(statusText(ctx), "info");
  const chooseScope = async (ctx: ExtensionContext): Promise<ConfigScope | undefined> => {
    const selected = await ctx.ui.select("Configuration scope", ["session", "workspace", "global"]);
    return selected as ConfigScope | undefined;
  };
  const configureModelInteractively = async (ctx: ExtensionContext, reset = false) => {
    if (!ctx.hasUI) {
      ctx.ui.notify("Use /knowledge-model <active|provider/model|reset> --scope <scope> outside TUI mode.", "warning");
      return;
    }
    const scope = await chooseScope(ctx);
    if (!scope) return;
    let policy: ModelPolicy | undefined;
    if (!reset) {
      const choices = ["active", ...refreshAvailableModels(ctx).map((model) => `${model.provider}/${model.id}`).sort()];
      const selected = await ctx.ui.select("Background extraction model", choices);
      if (!selected) return;
      policy = parseKnowledgeModelArgs(selected).policy;
    }
    if (!await permitInactiveModelWrite(ctx, false, true)) return;
    updateModelScope(ctx, scope, policy);
    ctx.ui.notify(`Shared Knowledge ${reset ? "model reset" : "model saved"} for ${scope}.\n${statusText(ctx)}`, "info");
  };
  const confirmMaterializerAuthority = async (ctx: ExtensionContext, policy: MaterializerPolicy) => {
    if (policy.mode === "review") return true;
    if (!ctx.hasUI) throw new Error(`${policy.mode} materializer requires dialog-capable confirmation`);
    const message = policy.mode === "inbox"
      ? "Successful jobs can write knowledge/inbox files and invoke ordered no-git absorption. Continue?"
      : "Successful jobs delegate validated candidate JSON to an externally configured command binding. Continue?";
    return ctx.ui.confirm(`Confirm ${policy.mode} materializer`, message);
  };
  const configureMaterializerInteractively = async (ctx: ExtensionContext, reset = false) => {
    if (!ctx.hasUI) {
      ctx.ui.notify("Use /knowledge-materializer <review|inbox|command|reset> --scope <scope> outside TUI mode.", "warning");
      return;
    }
    const scope = await chooseScope(ctx);
    if (!scope) return;
    let policy: MaterializerPolicy | undefined;
    if (!reset) {
      const selected = await ctx.ui.select("Background materializer", ["review", "inbox", "command"]);
      if (!selected) return;
      policy = parseKnowledgeMaterializerArgs(selected).policy;
      if (policy?.mode === "command" && !commandBinding().available) {
        ctx.ui.notify("shared-knowledge config: command materializer binding is unavailable", "error");
        return;
      }
      if (policy && !await confirmMaterializerAuthority(ctx, policy)) return;
    }
    updateMaterializerScope(ctx, scope, policy);
    ctx.ui.notify(`Shared Knowledge ${reset ? "materializer reset" : "materializer saved"} for ${scope}.\n${statusText(ctx)}`, "info");
  };

  const confirmPublisherAuthority = async (ctx: ExtensionContext, policy: PublisherPolicy) => {
    if (policy.mode === "off") return true;
    if (!ctx.hasUI || ctx.mode !== "tui") throw new Error(`${policy.mode} publisher requires --acknowledge outside local TUI mode`);
    const detail = policy.mode === "auto-merge"
      ? "Approved candidates may be canonically absorbed in isolation, pushed to a PR, and squash merged when checks pass or are absent. Branch protection and required reviews are not bypassed. Continue?"
      : "Approved candidates may be canonically absorbed in isolation, pushed, and opened as pull requests. Continue?";
    return ctx.ui.confirm(`Confirm ${policy.mode} publisher`, detail);
  };
  const reconcilePublisher = (ctx: ExtensionContext) => {
    const effective = effectivePublisherFor(ctx);
    if (effective.error || !effective.policy || effective.policy.mode === "off") return [];
    return publisherQueueFor(ctx.cwd).reconcile(viewQueueFor(ctx.cwd).list(), effective.policy.mode);
  };
  const configurePublisherInteractively = async (ctx: ExtensionContext, reset = false) => {
    if (!ctx.hasUI) {
      ctx.ui.notify("Use /knowledge-publisher <off|pr|auto-merge|reset> --scope <scope> --acknowledge outside TUI mode.", "warning");
      return;
    }
    const scope = await chooseScope(ctx);
    if (!scope) return;
    let policy: PublisherPolicy | undefined;
    if (!reset) {
      const choices = scope === "global" ? ["off", "pr"] : ["off", "pr", "auto-merge"];
      const selected = await ctx.ui.select("Reviewed knowledge publisher", choices);
      if (!selected) return;
      policy = parseKnowledgePublisherArgs(`${selected} --scope ${scope}`).policy;
      if (policy && !await confirmPublisherAuthority(ctx, policy)) return;
    }
    updatePublisherScope(ctx, scope, policy);
    const reconciled = reconcilePublisher(ctx);
    if (reconciled.length) schedule(ctx, 0);
    ctx.ui.notify(`Shared Knowledge ${reset ? "publisher reset" : "publisher saved"} for ${scope}.\n${statusText(ctx)}`, "info");
  };

  const requeueIds = (ctx: ExtensionContext, ids: string[]) => {
    // Adopt a view queue without recovery before scheduling so an explicit
    // retry cannot turn another process's running job back into pending.
    const queue = queueFor(ctx.cwd, false);
    const requeued: string[] = [];
    for (const id of ids) {
      try {
        queue.retryFailed(id);
        requeued.push(id);
      } catch {
        // A concurrent worker/operator may have made this job ineligible.
      }
    }
    if (requeued.length > 0) schedule(ctx, 0);
    return requeued;
  };
  const retryOneInteractively = async (ctx: ExtensionContext) => {
    const failed = failedJobSummaries(viewQueueFor(ctx.cwd).list());
    if (failed.length === 0) {
      ctx.ui.notify("shared-knowledge: no failed jobs in this workspace", "info");
      return;
    }
    const labels = new Map(failed.map((job) => [
      `${job.id} · ${job.state} · attempts=${job.attempts} · created=${job.createdAt} · updated=${job.updatedAt} · model=${job.modelHint ?? "unknown"} · ${formatSafeJobDiagnostic(job.diagnostic)} · ${job.retryable ? "retryable" : "payload unavailable"}`,
      job,
    ]));
    const selected = await ctx.ui.select("Select failed job", [...labels.keys()]);
    const job = selected ? labels.get(selected) : undefined;
    if (!job) return;
    if (!job.retryable) {
      ctx.ui.notify("shared-knowledge: selected job has no retained payload and cannot be retried", "warning");
      return;
    }
    if (!await ctx.ui.confirm("Retry failed job", `Requeue ${job.id} for normal idle-gated processing?`)) return;
    const requeued = requeueIds(ctx, [job.id]);
    ctx.ui.notify(requeued.length === 1
      ? `shared-knowledge: requeued ${job.id}; processing starts when idle`
      : "shared-knowledge: selected job is no longer retryable", requeued.length === 1 ? "info" : "warning");
  };
  const retryAllInteractively = async (ctx: ExtensionContext, forceReview = false) => {
    const eligible = failedJobSummaries(viewQueueFor(ctx.cwd).list()).filter((job) => job.retryable);
    if (eligible.length === 0) {
      ctx.ui.notify("shared-knowledge: no retained failed jobs are eligible for retry", "info");
      return;
    }
    const title = forceReview ? "Set review mode and retry failed jobs" : "Retry failed jobs";
    const detail = forceReview
      ? `Set workspace materializer to review and requeue ${eligible.length} retained failed job(s)?`
      : `Requeue ${eligible.length} retained failed job(s) for normal idle-gated processing?`;
    if (!await ctx.ui.confirm(title, detail)) return;
    try {
      if (forceReview) updateMaterializerScope(ctx, "workspace", { mode: "review" });
      const requeued = requeueIds(ctx, eligible.map((job) => job.id));
      ctx.ui.notify(`shared-knowledge: ${forceReview ? "workspace review mode set; " : ""}requeued ${requeued.length}/${eligible.length} job(s); processing starts when idle`, "info");
    } catch {
      ctx.ui.notify("shared-knowledge: recovery configuration could not be saved; no jobs were requeued", "error");
    }
  };
  const openJobsUi = async (ctx: ExtensionContext) => {
    if (!ctx.hasUI) {
      ctx.ui.notify(`${statusText(ctx)}\nUse dialog-capable UI for failed-job recovery.`, "info");
      return;
    }
    const failed = failedJobSummaries(viewQueueFor(ctx.cwd).list());
    const eligibleCount = failed.filter((job) => job.retryable).length;
    const action = await ctx.ui.select("Shared Knowledge job recovery", [
      `Retry one failed job (${eligibleCount})`,
      `Retry all retryable failed jobs (${eligibleCount})`,
      `Set workspace review mode and retry all (${eligibleCount})`,
      "Show status",
    ]);
    if (action?.startsWith("Retry one")) await retryOneInteractively(ctx);
    else if (action?.startsWith("Retry all")) await retryAllInteractively(ctx);
    else if (action?.startsWith("Set workspace review")) await retryAllInteractively(ctx, true);
    else if (action === "Show status") showStatus(ctx);
  };

  const openReviewUi = async (ctx: ExtensionContext) => {
    const queue = viewQueueFor(ctx.cwd);
    if (ctx.mode !== "tui") {
      const count = queue.reviewJobSummaries().length;
      ctx.ui.notify(`shared-knowledge: review-ready jobs=${count}; open /knowledge-review in local interactive TUI to inspect candidates`, "info");
      return;
    }
    while (true) {
      const jobs = queue.reviewJobSummaries();
      if (jobs.length === 0) {
        ctx.ui.notify("shared-knowledge: no review-ready jobs in this workspace", "info");
        return;
      }
      const jobId = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) =>
        new ReviewJobSelector(jobs, theme, tui, done),
      );
      if (!jobId) return;
      let index = 0;
      while (true) {
        const items = queue.pendingReviewItems(jobId);
        if (items.length === 0) {
          const selected = jobs.find((job) => job.id === jobId);
          if (!selected?.hasReviewContent) {
            const confirmed = await ctx.ui.confirm(
              "Close unavailable review job",
              "This closes private empty or expired review state only. It does not delete a job record, write checkout content, run a model/materializer/absorber/command, or use Git. Continue?",
            );
            if (!confirmed) return;
            try {
              const outcome = await queue.closeUnavailableReviewJob(jobId);
              if (outcome.status === "closed") {
                ctx.ui.notify(
                  outcome.outcome === "empty"
                    ? "shared-knowledge: empty review job closed"
                    : "shared-knowledge: unavailable review job closed as expired",
                  "info",
                );
              } else if (outcome.status === "actionable") {
                ctx.ui.notify("shared-knowledge: review job now has actionable pending candidates", "warning");
              } else {
                ctx.ui.notify("shared-knowledge: review job is no longer eligible to close", "warning");
              }
            } catch {
              ctx.ui.notify("shared-knowledge: unavailable review job could not be closed", "error");
            }
          } else {
            ctx.ui.notify("shared-knowledge: selected review job has no pending candidates", "info");
          }
          break;
        }
        const action = await ctx.ui.custom<ReviewUiAction | null>((tui, theme, _keybindings, done) =>
          new ReviewCandidateViewer(jobId, items, index, theme, tui, done),
        );
        if (!action || action.action === "close") break;
        index = action.index;
        if (action.action === "approve") {
          const confirmed = await ctx.ui.confirm(
            "Approve candidate to Inbox",
            "This stages one candidate under knowledge/inbox. It does not run absorption, a model, a command, Git staging/commit, or canonical promotion. Continue?",
          );
          if (!confirmed) continue;
          try {
            const outcome = await queue.approveReviewItem(
              jobId,
              action.itemId,
              inboxCandidateIdentity,
              async (candidate) => {
                const staged = materializeInboxCandidate(candidate, ctx.cwd);
                return {
                  outcome: staged.alreadyStaged ? "already-staged" : "staged",
                  ...(staged.written ? { inboxPath: staged.written } : {}),
                };
              },
            );
            if (outcome.status === "approved") {
              ctx.ui.notify(
                outcome.decision?.outcome === "already-staged"
                  ? "shared-knowledge: candidate was already staged in Inbox"
                  : "shared-knowledge: candidate staged in Inbox",
                "info",
              );
              if (outcome.job?.state === "done" && reconcilePublisher(ctx).length > 0 && (ctx as { isIdle?: () => boolean }).isIdle?.()) schedule(ctx, 0);
            } else if (outcome.status === "already-decided") {
              ctx.ui.notify("shared-knowledge: candidate is no longer pending", "warning");
            } else {
              ctx.ui.notify("shared-knowledge: review candidate is unavailable", "warning");
            }
          } catch {
            ctx.ui.notify("shared-knowledge: review approval could not be completed", "error");
          }
        } else if (action.action === "reject") {
          const confirmed = await ctx.ui.confirm(
            "Reject candidate",
            "This records a private rejection decision and does not modify the checkout. Continue?",
          );
          if (!confirmed) continue;
          try {
            const outcome = await queue.rejectReviewItem(jobId, action.itemId);
            if (outcome.status === "rejected") ctx.ui.notify("shared-knowledge: candidate rejected", "info");
            else if (outcome.status === "already-decided") ctx.ui.notify("shared-knowledge: candidate is no longer pending", "warning");
            else ctx.ui.notify("shared-knowledge: review candidate is unavailable", "warning");
          } catch {
            ctx.ui.notify("shared-knowledge: review rejection could not be completed", "error");
          }
        }
      }
    }
  };

  const feedbackSummaryText = (ctx: ExtensionContext) => {
    const summary = feedbackStoreFor(ctx.cwd).summary();
    return `shared-knowledge feedback: findings=${summary.findings} local-only=${summary.localOnly} insufficient=${summary.insufficient} tracking=${summary.tracking} ready=${summary.readyForReview} linked=${summary.linked} submitted=${summary.submitted}`;
  };
  const feedbackGroupLabel = (group: FeedbackReportFinding["group"]) => ({
    "local-or-environment": "Local or environment blocker",
    "upstream-candidate": "Upstream tracking or ready candidate",
    "agent-or-workflow": "Agent or workflow observation",
    "insufficient-evidence": "Insufficient evidence",
  })[group];
  const feedbackFindingText = (entry: FeedbackReportFinding, store: SessionFeedbackStore) => {
    const finding = store.finding(entry.id);
    if (!finding) return undefined;
    const text = (value: string | undefined) => sanitizeFeedbackText(value, 1_200) ?? "(unavailable)";
    const readiness = entry.clusterState === "tracking"
      ? `Automatic readiness: ${entry.additionalIndependentObservationsRequired ?? 0} additional independent session observation(s) required.`
      : entry.clusterState
        ? "Automatic readiness: no further independent observation is required for the current cluster state."
        : undefined;
    return [
      `Report group: ${feedbackGroupLabel(entry.group)}`,
      `Classification: ${finding.classification}`,
      `Component: ${finding.component.kind}/${finding.component.id}`,
      `Repository: ${finding.repository ?? "unresolved"}`,
      `Disposition: ${finding.disposition}`,
      ...(entry.clusterState ? [
        `Cluster state: ${entry.clusterState}`,
        `This session contributes to ${entry.independentSessionCount ?? 0} eligible independent session observation(s).`,
        ...(readiness ? [readiness] : []),
      ] : []),
      "",
      "User goal:", text(finding.userGoal),
      "",
      "Expected:", text(finding.expected),
      "",
      "Observed:", text(finding.observed),
      ...(finding.workaround ? ["", "Workaround:", text(finding.workaround)] : []),
      ...(finding.evidenceSummary ? ["", "Safe evidence summary:", text(finding.evidenceSummary)] : []),
    ].join("\n");
  };
  const openFeedbackUi = async (ctx: ExtensionContext) => {
    const store = feedbackStoreFor(ctx.cwd);
    if (ctx.mode !== "tui") {
      ctx.ui.notify(`${feedbackSummaryText(ctx)}\nOpen /knowledge-feedback in local TUI to inspect private findings.`, "info");
      return;
    }
    const sessionSource = feedbackSessionSourceFor(ctx);
    const report = store.report(sessionSource);
    if (report.findingsForSession.length === 0) {
      ctx.ui.notify("shared-knowledge feedback: no retained findings for this session", "info");
      return;
    }
    const purgeLabel = "Purge all retained feedback for this session";
    const labels = new Map(report.findingsForSession.map((finding) => {
      const contribution = finding.clusterState
        ? `${finding.clusterState} · sessions=${finding.independentSessionCount ?? 0}${finding.additionalIndependentObservationsRequired ? ` · needs=${finding.additionalIndependentObservationsRequired}` : ""}`
        : finding.disposition;
      return [
        `${feedbackGroupLabel(finding.group)} · ${finding.id} · ${finding.classification} · ${finding.component.id} · ${contribution}`,
        finding,
      ];
    }));
    const selected = await ctx.ui.select("Session feedback report", [...labels.keys(), purgeLabel]);
    if (!selected) return;
    if (selected === purgeLabel) {
      if (!await ctx.ui.confirm("Purge session feedback", "This removes only private feedback findings and their cluster contributions. It does not modify knowledge, Git, or GitHub. Continue?")) return;
      ctx.ui.notify(`shared-knowledge feedback: purged ${store.purgeSession(sessionSource)} finding(s)`, "info");
      return;
    }
    const entry = labels.get(selected);
    if (!entry) return;
    const id = entry.id;
    const finding = store.finding(id);
    const detail = feedbackFindingText(entry, store);
    if (!finding || !detail) {
      ctx.ui.notify("shared-knowledge feedback: selected finding is unavailable", "warning");
      return;
    }
    const action = await ctx.ui.select("Session feedback finding action", [
      "View private detail",
      "Dismiss finding",
      "Remove finding permanently",
      "Suppress this classification for this component",
    ]);
    if (!action || action === "View private detail") {
      if (action) await ctx.ui.editor("Private session feedback finding", detail);
      return;
    }
    if (action === "Dismiss finding") {
      if (!await ctx.ui.confirm("Dismiss session finding", "This changes only private feedback state. Continue?")) return;
      ctx.ui.notify(store.dismissFinding(id) ? "shared-knowledge feedback: finding dismissed" : "shared-knowledge feedback: finding is unavailable", "info");
      return;
    }
    if (action === "Remove finding permanently") {
      if (!await ctx.ui.confirm("Remove session finding", "This removes the finding and its private cluster contribution. It does not modify knowledge, Git, or GitHub. Continue?")) return;
      ctx.ui.notify(store.removeFinding(id) ? "shared-knowledge feedback: finding removed" : "shared-knowledge feedback: finding is unavailable", "info");
      return;
    }
    if (action === "Suppress this classification for this component") {
      if (!await ctx.ui.confirm("Suppress feedback classification", "Future matching findings remain private and will not enter the upstream queue. Continue?")) return;
      store.suppress(finding.classification, finding.component.id, finding.repository);
      ctx.ui.notify("shared-knowledge feedback: classification suppressed locally", "info");
    }
  };
  const openIssueQueueUi = async (ctx: ExtensionContext) => {
    const store = feedbackStoreFor(ctx.cwd);
    if (ctx.mode !== "tui") {
      ctx.ui.notify(`${feedbackSummaryText(ctx)}\nOpen /knowledge-issue-queue in local TUI to inspect or submit candidates.`, "info");
      return;
    }
    const summaries = store.queue();
    if (summaries.length === 0) {
      ctx.ui.notify("shared-knowledge feedback: no upstream issue candidates in this workspace", "info");
      return;
    }
    const labels = new Map(summaries.map((summary) => [
      `${summary.id} · ${summary.state} · sessions=${summary.independentSessionCount} · ${summary.title}`,
      summary.id,
    ]));
    const selected = await ctx.ui.select("Private upstream issue queue", [...labels.keys()]);
    const id = selected ? labels.get(selected) : undefined;
    if (!id) return;
    const cluster = store.cluster(id);
    if (!cluster) {
      ctx.ui.notify("shared-knowledge feedback: selected candidate is unavailable", "warning");
      return;
    }
    const actions = [
      "View candidate metadata",
      ...(cluster.draft ? ["View redacted draft", "Edit redacted draft"] : []),
      ...(cluster.state === "tracking" ? ["Manually promote candidate"] : []),
      ...(cluster.findingIds.length > 1 ? ["Split one finding into a new cluster"] : []),
      ...(cluster.state === "ready-for-review" || cluster.state === "manually-promoted"
        ? ["Search GitHub for duplicates", "Link existing GitHub issue", "Submit GitHub issue"]
        : []),
      "Dismiss candidate",
      "Suppress this classification for this component",
    ];
    const action = await ctx.ui.select("Issue candidate action", actions);
    if (!action) return;
    if (action === "View candidate metadata") {
      const detail = [
        `State: ${cluster.state}`,
        `Repository: ${cluster.repository}`,
        `Component: ${cluster.component.kind}/${cluster.component.id}`,
        `Classification: ${cluster.classification}`,
        `Independent sessions: ${new Set(cluster.findingIds.map((findingId) => store.finding(findingId)?.sessionFingerprint).filter(Boolean)).size}`,
        "", "Matching reasons:", ...cluster.matchReasons.map((reason) => `- ${sanitizeFeedbackText(reason, 240) ?? "(unavailable)"}`),
      ].join("\n");
      await ctx.ui.editor("Private issue candidate metadata", detail);
      return;
    }
    if (action === "View redacted draft" && cluster.draft) {
      await ctx.ui.editor("Redacted GitHub issue draft", `${cluster.draft.title}\n\n${cluster.draft.body}`);
      return;
    }
    if (action === "Edit redacted draft" && cluster.draft) {
      const title = await ctx.ui.input("Issue title", cluster.draft.title);
      if (title === undefined) return;
      const body = await ctx.ui.editor("Issue body", cluster.draft.body);
      if (body === undefined) return;
      const updated = store.updateDraft(id, title, body);
      ctx.ui.notify(updated ? "shared-knowledge feedback: local draft updated" : "shared-knowledge feedback: draft update was rejected", updated ? "info" : "warning");
      return;
    }
    if (action === "Manually promote candidate") {
      if (!await ctx.ui.confirm("Manually promote candidate", "This bypasses the two-session automatic readiness rule but does not contact GitHub. Continue?")) return;
      ctx.ui.notify(store.manualPromote(id) ? "shared-knowledge feedback: candidate manually promoted" : "shared-knowledge feedback: candidate is unavailable", "info");
      return;
    }
    if (action === "Split one finding into a new cluster") {
      const choices = cluster.findingIds.map((findingId) => {
        const finding = store.finding(findingId);
        return `${findingId} · ${finding?.classification ?? "unavailable"} · ${finding?.component.id ?? "unavailable"}`;
      });
      const selectedFinding = await ctx.ui.select("Select finding to split", choices);
      const findingId = selectedFinding?.split(" · ", 1)[0];
      if (!findingId) return;
      ctx.ui.notify(store.splitCluster(id, [findingId]) ? "shared-knowledge feedback: candidate cluster split" : "shared-knowledge feedback: split was unavailable", "info");
      return;
    }
    if (action === "Search GitHub for duplicates") {
      const result = store.searchDuplicates(id);
      ctx.ui.notify(result.status === "ok"
        ? `shared-knowledge feedback: duplicate search returned ${result.results.length} bounded result(s)`
        : "shared-knowledge feedback: duplicate search failed; candidate remains local and retryable", result.status === "ok" ? "info" : "warning");
      return;
    }
    if (action === "Link existing GitHub issue") {
      const url = await ctx.ui.input("Existing issue URL", `https://github.com/${cluster.repository}/issues/`);
      if (url === undefined) return;
      const linked = store.linkExistingIssue(id, url);
      ctx.ui.notify(linked
        ? "shared-knowledge feedback: linked existing GitHub issue locally"
        : "shared-knowledge feedback: URL was rejected", linked ? "info" : "warning");
      return;
    }
    if (action === "Submit GitHub issue" && cluster.draft) {
      const reviewedTitle = await ctx.ui.input("Review final sanitized GitHub issue title", cluster.draft.title);
      if (reviewedTitle === undefined) return;
      const reviewedBody = await ctx.ui.editor("Review final sanitized GitHub issue body", cluster.draft.body);
      if (reviewedBody === undefined) return;
      if (!store.updateDraft(id, reviewedTitle, reviewedBody)) {
        ctx.ui.notify("shared-knowledge feedback: final draft was rejected", "warning");
        return;
      }
      if (!await ctx.ui.confirm("Create GitHub issue", `Create this issue in ${cluster.repository}? This is a public external action.`)) return;
      const submitted = store.submit(id);
      ctx.ui.notify(submitted
        ? `shared-knowledge feedback: GitHub issue submitted: ${submitted.url}`
        : "shared-knowledge feedback: GitHub submission failed; candidate remains local and retryable", submitted ? "info" : "warning");
      return;
    }
    if (action === "Dismiss candidate") {
      if (!await ctx.ui.confirm("Dismiss issue candidate", "This only changes private local feedback state. Continue?")) return;
      ctx.ui.notify(store.dismissCluster(id) ? "shared-knowledge feedback: candidate dismissed" : "shared-knowledge feedback: candidate is unavailable", "info");
      return;
    }
    if (action === "Suppress this classification for this component") {
      if (!await ctx.ui.confirm("Suppress feedback classification", "Future matching findings remain private and will not enter the upstream queue. Continue?")) return;
      store.suppress(cluster.classification, cluster.component.id, cluster.repository);
      ctx.ui.notify("shared-knowledge feedback: classification suppressed locally", "info");
    }
  };

  pi.registerCommand("knowledge-feedback", {
    description: "View the private quality report for the current Shared Knowledge session",
    handler: async (_args, ctx) => openFeedbackUi(ctx),
  });
  pi.registerCommand("knowledge-issue-queue", {
    description: "Review private upstream issue candidates and explicitly submit GitHub drafts",
    handler: async (_args, ctx) => openIssueQueueUi(ctx),
  });

  pi.registerCommand("knowledge-model", {
    description: "Choose the Shared Knowledge background extraction model",
    getArgumentCompletions: (prefix) => {
      const values = modelArgumentCompletions(availableModels, prefix);
      return values.length ? values.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      try {
        refreshAvailableModels(ctx);
        const parsed = parseKnowledgeModelArgs(args);
        if (!parsed.action) return configureModelInteractively(ctx);
        if (!await permitInactiveModelWrite(ctx, parsed.allowInactive, false)) return;
        if (parsed.policy?.mode === "fixed") {
          const fixedPolicy = parsed.policy;
          const known = ctx.modelRegistry.getAvailable().some((model) => model.provider === fixedPolicy.provider && model.id === fixedPolicy.modelId);
          if (!known) throw new Error(`model is unavailable or unauthenticated: ${formatModelPolicy(fixedPolicy)}`);
        }
        updateModelScope(ctx, parsed.scope, parsed.policy);
        ctx.ui.notify(`Shared Knowledge ${parsed.action === "reset" ? "model reset" : "model saved"} for ${parsed.scope}.\n${statusText(ctx)}`, "info");
      } catch (error) {
        ctx.ui.notify(`shared-knowledge config: ${String(error).slice(0, 300)}`, "error");
      }
    },
  });
  pi.registerCommand("knowledge-materializer", {
    description: "Configure the Shared Knowledge materializer policy",
    getArgumentCompletions: (prefix) => {
      const values = materializerArgumentCompletions(prefix);
      return values.length ? values.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      try {
        const parsed = parseKnowledgeMaterializerArgs(args);
        if (!parsed.action) return configureMaterializerInteractively(ctx);
        if (parsed.policy?.mode === "command" && !commandBinding().available) {
          throw new Error("command materializer binding is unavailable");
        }
        if (parsed.policy && !await confirmMaterializerAuthority(ctx, parsed.policy)) return;
        updateMaterializerScope(ctx, parsed.scope, parsed.policy);
        ctx.ui.notify(`Shared Knowledge ${parsed.action === "reset" ? "materializer reset" : "materializer saved"} for ${parsed.scope}.\n${statusText(ctx)}`, "info");
      } catch (error) {
        ctx.ui.notify(`shared-knowledge config: ${String(error).slice(0, 300)}`, "error");
      }
    },
  });
  pi.registerCommand("knowledge-publisher", {
    description: "Configure or flush reviewed Shared Knowledge PR publication",
    getArgumentCompletions: (prefix) => {
      const values = ["off", "pr", "auto-merge", "reset", "flush", "retry", "--scope session", "--scope workspace", "--scope global", "--acknowledge"]
        .filter((value) => value.startsWith(prefix.trim()));
      return values.length ? values.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      try {
        const parsed = parseKnowledgePublisherArgs(args);
        if (!parsed.action) return configurePublisherInteractively(ctx);
        if (parsed.action === "flush") {
          const jobs = reconcilePublisher(ctx);
          if (jobs.length) schedule(ctx, 0);
          ctx.ui.notify(`shared-knowledge publisher: reconciled ${jobs.length} reviewed publication job(s)`, "info");
          return;
        }
        if (parsed.action === "retry") {
          const queue = publisherQueueFor(ctx.cwd);
          let count = 0;
          for (const job of queue.list()) {
            if (["blocked", "failed", "waiting"].includes(job.state)) {
              try { queue.retry(job.id); count += 1; } catch { /* stale */ }
            }
          }
          if (count) schedule(ctx, 0);
          ctx.ui.notify(`shared-knowledge publisher: requeued ${count} job(s)`, "info");
          return;
        }
        if (parsed.policy && parsed.policy.mode !== "off" && !parsed.acknowledged) {
          if (!ctx.hasUI || ctx.mode !== "tui" || !await confirmPublisherAuthority(ctx, parsed.policy)) {
            throw new Error("publisher authority requires --acknowledge or dialog confirmation");
          }
        }
        updatePublisherScope(ctx, parsed.scope, parsed.policy);
        const jobs = reconcilePublisher(ctx);
        if (jobs.length) schedule(ctx, 0);
        ctx.ui.notify(`Shared Knowledge ${parsed.action === "reset" ? "publisher reset" : "publisher saved"} for ${parsed.scope}.\n${statusText(ctx)}`, "info");
      } catch (error) {
        ctx.ui.notify(`shared-knowledge config: ${String(error).slice(0, 300)}`, "error");
      }
    },
  });
  pi.registerCommand("knowledge-config", {
    description: "Open Shared Knowledge configuration and recovery",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return showStatus(ctx);
      const action = await ctx.ui.select("Shared Knowledge configuration", [
        "Change extraction model",
        "Change materializer",
        "Change publisher",
        "Reset extraction model scope",
        "Reset materializer scope",
        "Reset publisher scope",
        "Flush reviewed publication",
        "Recover failed jobs",
        "Review ready candidates",
        "View session feedback report",
        "Open upstream issue queue",
        "Show status",
      ]);
      if (action === "Change extraction model") await configureModelInteractively(ctx);
      else if (action === "Change materializer") await configureMaterializerInteractively(ctx);
      else if (action === "Change publisher") await configurePublisherInteractively(ctx);
      else if (action === "Reset extraction model scope") await configureModelInteractively(ctx, true);
      else if (action === "Reset materializer scope") await configureMaterializerInteractively(ctx, true);
      else if (action === "Reset publisher scope") await configurePublisherInteractively(ctx, true);
      else if (action === "Flush reviewed publication") {
        const jobs = reconcilePublisher(ctx);
        if (jobs.length) schedule(ctx, 0);
        ctx.ui.notify(`shared-knowledge publisher: reconciled ${jobs.length} reviewed publication job(s)`, "info");
      }
      else if (action === "Recover failed jobs") await openJobsUi(ctx);
      else if (action === "Review ready candidates") await openReviewUi(ctx);
      else if (action === "View session feedback report") await openFeedbackUi(ctx);
      else if (action === "Open upstream issue queue") await openIssueQueueUi(ctx);
      else if (action === "Show status") showStatus(ctx);
    },
  });
  pi.registerCommand("knowledge-status", {
    description: "Show effective Shared Knowledge background configuration and queue counts",
    handler: async (_args, ctx) => showStatus(ctx),
  });
  pi.registerCommand("knowledge-jobs", {
    description: "Inspect and safely retry failed Shared Knowledge jobs",
    handler: async (_args, ctx) => openJobsUi(ctx),
  });
  pi.registerCommand("knowledge-review", {
    description: "Review and approve retained Shared Knowledge candidates locally",
    handler: async (_args, ctx) => openReviewUi(ctx),
  });

  const processOne = async (ctx: ExtensionContext, queue: KnowledgeJobQueue, job: KnowledgeJob) => {
    if (!job.payload || !isMeaningfulConversation(job.payload.conversation)) {
      queue.update(job.id, { state: "skipped", error: undefined });
      return;
    }
    const effectiveModel = effectiveModelFor(ctx);
    // Resolve once per attempt so a policy change cannot switch authority
    // between extraction and materialization of the same durable job.
    const materializer = requireMaterializerConfig(effectiveMaterializerFor(ctx));
    const model = selectExtractionModel(effectiveModel, ctx.model, (provider, modelId) => ctx.modelRegistry.find(provider, modelId));
    const auth = requireModelAuthentication(await ctx.modelRegistry.getApiKeyAndHeaders(model), `${model.provider}/${model.id}`);
    queue.update(job.id, { state: "running", modelHint: model.id, error: undefined });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Background extraction timed out")), queue.config.timeoutMs ?? 120_000);
    timeout.unref();
    let response: Awaited<ReturnType<typeof complete>>;
    try {
      const retryInstruction = extractionRetryInstruction(job.attempts, job.error);
      response = await complete(model, {
        messages: [{
          role: "user",
          content: [{
            type: "text",
            text: `${promptText()}${retryInstruction ? `\n\n${retryInstruction}` : ""}\n\nSubmit the result with the ${CANDIDATE_SUBMISSION_TOOL_NAME} tool.\n\nReview this conversation:\n\n${job.payload.conversation}`,
          }],
          timestamp: Date.now(),
        }],
        tools: [CANDIDATE_SUBMISSION_TOOL],
      }, { apiKey: auth.apiKey, headers: auth.headers, maxTokens: 4096, signal: controller.signal, toolChoice: "required" });
    } finally {
      clearTimeout(timeout);
    }

    const parsed = parseCandidateAssistantResponse<Candidate>(response.content, response.stopReason);
    const candidates = parsed.candidates
      .filter((candidate) => validateCandidate(candidate).length === 0)
      .map((candidate) => job.payload?.source ? {
        ...candidate,
        capture_source: `source:${job.payload.source.instanceId}`,
        source_instance: job.payload.source.instanceId,
        source_run_id: job.payload.source.runId,
        evidence_snapshot: job.payload.source.snapshot,
        source_revision: job.payload.source.revision,
        evidence_paths: job.payload.source.evidencePaths ?? [],
      } : candidate);
    // Feedback is deliberately best-effort and isolated from candidate
    // materialization. Its store receives only validated redacted fields.
    const feedbackInputs = Array.isArray(parsed.feedback_findings) ? parsed.feedback_findings : [];
    if (feedbackInputs.length > 0) {
      try {
        const feedback = feedbackStoreFor(ctx.cwd).ingest(job.payload.sessionId, feedbackInputs);
        if (feedback.findings.length > 0) {
          ctx.ui.setWidget("shared-knowledge-feedback", [
            `Session feedback retained: findings=${feedback.findings.length} tracking=${feedback.summary.tracking} ready=${feedback.summary.readyForReview}`,
          ]);
        }
      } catch {
        // A feedback failure cannot turn a successful knowledge job into a retry.
        ctx.ui.notify("shared-knowledge feedback: analysis was not retained", "warning");
      }
    }
    const result = await materializeCandidates(materializer, candidates, ctx.cwd);
    if (result.mode === "inbox" && result.written.length > 0) await runAbsorber(ctx.cwd);
    if (job.payload.source) {
      await runSourceAck(ctx.cwd, job.payload.source.instanceId, job.payload.source.runId);
    }
    const state = result.mode === "review" && candidates.length > 0 ? "review-ready" : "done";
    queue.update(job.id, {
      state,
      error: undefined,
      payload: undefined,
      result: result.mode === "review"
        ? createReviewResult(candidates)
        : {
          candidateCount: candidates.length,
          materializer: result.mode,
          written: result.written,
        },
    });
    const detail = result.mode === "review"
      ? candidates.length > 0
        ? `${candidates.length} background candidate(s) ready for review; checkout unchanged`
        : "no durable background candidates found; review complete"
      : result.mode === "command"
        ? `${candidates.length} background candidate(s) delegated`
        : `${result.written.length} candidate(s) materialized and absorption completed`;
    ctx.ui.setWidget("shared-knowledge", [detail]);
    ctx.ui.notify(`shared-knowledge: ${detail}`, "info");
  };

  const drainPublisher = (ctx: ExtensionContext): boolean => {
    const cwd = ctx.cwd;
    if (!ctx.isIdle() || busy.has(cwd) || running.has(cwd) || publisherRunning.has(cwd)) return false;
    const effective = effectivePublisherFor(ctx);
    if (effective.error || !effective.policy || effective.policy.mode === "off") return false;
    const queue = publisherQueueFor(cwd);
    const publishJobs = queue.list();
    const manualPrOpen = effective.policy?.mode === "pr" && publishJobs.some((job) => ["pr-open", "waiting"].includes(job.state) && Boolean(job.prNumber));
    const refreshableManualPr = effective.policy?.mode === "pr" && publishJobs.some((job) => ["pr-open", "waiting"].includes(job.state) && Boolean(job.prNumber) && job.attempts < 20);
    const publishable = refreshableManualPr || (!manualPrOpen && publishJobs.some((job) => ["pending", "preparing", "validated", "pushed"].includes(job.state)
      || (effective.policy?.mode === "auto-merge" && ["pr-open", "waiting"].includes(job.state) && Boolean(job.prNumber) && job.attempts < 20)));
    if (!publishable) return false;
    publisherRunning.add(cwd);
    ctx.ui.setStatus("shared-knowledge-publisher", "Publishing reviewed knowledge…");
    const runtime = new KnowledgePublisherRuntime(queue, {
      absorberScript: ABSORBER_SCRIPT,
      lintScript: LINT_SCRIPT,
      policyActive: (expected) => {
        const current = effectivePublisherFor(ctx);
        return !current.error && current.policy?.mode === expected;
      },
    });
    void runtime.processNext(effective.policy.mode)
      .then((job) => {
        if (!job) return;
        const detail = job.state === "merged"
          ? "reviewed knowledge PR squash merged"
          : job.state === "pr-open"
            ? `reviewed knowledge PR opened${job.prUrl ? `: ${job.prUrl}` : ""}`
            : job.state === "already-canonical"
              ? "reviewed knowledge was already canonical"
              : `publisher state=${job.state} diagnostic=${job.diagnostic ?? "none"}`;
        ctx.ui.notify(`shared-knowledge: ${detail}`, ["blocked", "failed"].includes(job.state) ? "warning" : "info");
      })
      .catch(() => ctx.ui.notify("shared-knowledge: publisher failed with bounded diagnostic", "error"))
      .finally(() => {
        publisherRunning.delete(cwd);
        ctx.ui.setStatus("shared-knowledge-publisher", undefined);
        if (ctx.isIdle()) schedule(ctx);
      });
    return true;
  };

  const drain = (ctx: ExtensionContext) => {
    if (!ctx.isIdle()) return;
    const cwd = ctx.cwd;
    if (busy.has(cwd) || running.has(cwd) || publisherRunning.has(cwd)) return;
    if (drainPublisher(ctx)) return;
    if (process.env.SHARED_KNOWLEDGE_ASYNC_EXTRACTION === "0") return;
    const queue = queueFor(cwd);
    const batch = queue.nextReadyBatch();
    const first = batch[0];
    if (!first) return;
    const combined = batch.length > 1
      ? normalizeConversation(
        batch.map((item, index) => `--- captured segment ${index + 1} ---\n${item.payload?.conversation ?? ""}`).join("\n\n"),
        queue.config.maxPayloadBytes,
        queue.config.excludePatterns ?? [],
      )
      : null;
    const job = combined && first.payload ? {
      ...first,
      payload: {
        ...first.payload,
        conversation: combined.text,
        originalBytes: combined.originalBytes,
        truncated: combined.truncated || batch.some((item) => item.payload?.truncated),
      },
    } : first;
    running.add(cwd);
    ctx.ui.setStatus("shared-knowledge", `Extracting ${batch.length} knowledge job(s) in background…`);
    void processOne(ctx, queue, job)
      .then(() => {
        const followerPatch = batchFollowerPatch(queue.read(first.id));
        for (const item of batch.slice(1)) queue.update(item.id, followerPatch);
      })
      .catch((error) => {
        const updated = batch.map((item) => queue.markRetry(item.id, error));
        const terminal = updated.find((item) => item.state === "failed");
        const representative = terminal ?? updated[0];
        if (representative) {
          const notice = extractionFailureNotice(
            representative.state === "failed" ? "failed" : "retry-wait",
            representative.attempts,
            representative.id,
            error,
          );
          ctx.ui.notify(notice.message, notice.level);
        }
      })
      .finally(() => {
        running.delete(cwd);
        ctx.ui.setStatus("shared-knowledge", undefined);
        if (ctx.isIdle()) schedule(ctx);
      });
  };

  function schedule(ctx: ExtensionContext, delayMs = parseQueueConfig().debounceMs) {
    const cwd = ctx.cwd;
    const previous = timers.get(cwd);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      timers.delete(cwd);
      drain(ctx);
    }, delayMs);
    timer.unref();
    timers.set(cwd, timer);
  }

  pi.on("session_before_compact", (event, ctx) => {
    if (process.env.SHARED_KNOWLEDGE_ASYNC_EXTRACTION === "0") return;
    const messages = event.preparation.messagesToSummarize;
    if (messages.length === 0) return;
    try {
      // Capture only: no credential lookup, network request, model call, or absorption.
      const conversation = serializeConversation(convertToLlm(messages));
      const sessionId = feedbackSessionSourceFor(ctx);
      const payload = createCapturedPayload(ctx.cwd, sessionId, conversation);
      const { created } = queueFor(ctx.cwd).enqueue(payload, ctx.model?.id);
      if (created) ctx.ui.setWidget("shared-knowledge", ["Knowledge extraction queued"]);
    } catch (error) {
      ctx.ui.notify(`shared-knowledge capture skipped: ${String(error)}`, "warning");
    }
  });

  pi.on("session_start", (_event, ctx) => {
    refreshAvailableModels(ctx);
    if (reconcilePublisher(ctx).length > 0) schedule(ctx, 0);
  });
  pi.on("session_compact", (_event, ctx) => schedule(ctx));
  pi.on("agent_start", (_event, ctx) => {
    busy.add(ctx.cwd);
    const timer = timers.get(ctx.cwd);
    if (timer) clearTimeout(timer);
    timers.delete(ctx.cwd);
  });
  pi.on("agent_settled", (_event, ctx) => {
    busy.delete(ctx.cwd);
    schedule(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    const timer = timers.get(ctx.cwd);
    if (timer) clearTimeout(timer);
    timers.delete(ctx.cwd);
    updateSessionPolicy(sessionModelPolicies, ctx);
    updateSessionPolicy(sessionMaterializerPolicies, ctx);
    updateSessionPolicy(sessionPublisherPolicies, ctx);
    feedbackSessionNonces.delete(ctx.sessionManager as object);
  });
}
