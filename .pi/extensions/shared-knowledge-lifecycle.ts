/** Checkout-safe, non-blocking shared-knowledge lifecycle integration for Pi. */
import { complete } from "@earendil-works/pi-ai/compat";
import { convertToLlm, getAgentDir, serializeConversation, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
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
  formatSafeJobDiagnostic,
  globalConfigPath,
  materializerArgumentCompletions,
  modelArgumentCompletions,
  parseKnowledgeMaterializerArgs,
  parseKnowledgeModelArgs,
  readConfig,
  requireMaterializerConfig,
  requireModelAuthentication,
  resolveEffectiveMaterializer,
  resolveEffectiveModel,
  selectExtractionModel,
  summarizeQueue,
  updateConfig,
  workspaceConfigPath,
  type ConfigScope,
  type MaterializerPolicy,
  type ModelPolicy,
} from "../../src/knowledge-config-runtime.ts";
import {
  CANDIDATE_SUBMISSION_TOOL_NAME,
  extractionFailureNotice,
  extractionRetryInstruction,
  parseCandidateAssistantResponse,
} from "../../src/candidate-response.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROMPT_FILE = join(PACKAGE_ROOT, ".pi", "prompts", "compact-review.md");
const ABSORBER_SCRIPT = join(PACKAGE_ROOT, "scripts", "knowledge_absorb.py");
const SOURCES_SCRIPT = join(PACKAGE_ROOT, "scripts", "knowledge_sources.py");
const running = new Set<string>();
const timers = new Map<string, NodeJS.Timeout>();
const busy = new Set<string>();
const CANDIDATE_SUBMISSION_TOOL = {
  name: CANDIDATE_SUBMISSION_TOOL_NAME,
  description: "Submit zero or more strictly structured durable shared-knowledge candidates.",
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
    : "Extract durable shared-knowledge candidates as JSON with a candidates array.";
}

export default function sharedKnowledgeLifecycle(pi: ExtensionAPI) {
  const queues = new Map<string, KnowledgeJobQueue>();
  const sessionModelPolicies = new Map<object | string, ModelPolicy>();
  const sessionMaterializerPolicies = new Map<object | string, MaterializerPolicy>();
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
    const queue = viewQueueFor(ctx.cwd);
    const counts = summarizeQueue(queue.list());
    const configuredModel = model.policy ? formatModelPolicy(model.policy) : "invalid environment value";
    const activeDetail = model.policy?.mode === "active"
      ? ` → ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no active model"}`
      : "";
    const configuredMaterializer = materializer.policy ? formatMaterializerPolicy(materializer.policy) : "invalid";
    return [
      `Extraction model: ${configuredModel}${activeDetail}`,
      `Source: ${model.source}${model.locked ? " (locked by environment)" : ""}`,
      model.error ? `Model configuration error: ${model.error.slice(0, 240)}` : undefined,
      `Materializer: ${configuredMaterializer}`,
      `Materializer source: ${materializer.source}`,
      materializer.policy?.mode === "command" ? `Command binding: ${materializer.commandBindingAvailable ? "available" : "unavailable"}` : undefined,
      materializer.error ? "Materializer configuration error" : undefined,
      `Runtime: ${queue.root}`,
      `Jobs: pending=${counts.pending} running=${counts.running} retry-wait=${counts["retry-wait"]} failed=${counts.failed} review-ready=${counts["review-ready"]}`,
      ...model.diagnostics.map((diagnostic) => `Warning: ${diagnostic}`),
      ...materializer.diagnostics.map((diagnostic) => `Warning: ${diagnostic}`),
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
          ctx.ui.notify("shared-knowledge: selected review job has no retained pending candidates", "info");
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
  pi.registerCommand("knowledge-config", {
    description: "Open Shared Knowledge configuration and recovery",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return showStatus(ctx);
      const action = await ctx.ui.select("Shared Knowledge configuration", [
        "Change extraction model",
        "Change materializer",
        "Reset extraction model scope",
        "Reset materializer scope",
        "Recover failed jobs",
        "Review ready candidates",
        "Show status",
      ]);
      if (action === "Change extraction model") await configureModelInteractively(ctx);
      else if (action === "Change materializer") await configureMaterializerInteractively(ctx);
      else if (action === "Reset extraction model scope") await configureModelInteractively(ctx, true);
      else if (action === "Reset materializer scope") await configureMaterializerInteractively(ctx, true);
      else if (action === "Recover failed jobs") await openJobsUi(ctx);
      else if (action === "Review ready candidates") await openReviewUi(ctx);
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
      .map((candidate) => job.payload?.source ? {
        ...candidate,
        capture_source: `source:${job.payload.source.instanceId}`,
        source_instance: job.payload.source.instanceId,
        source_run_id: job.payload.source.runId,
        evidence_snapshot: job.payload.source.snapshot,
        source_revision: job.payload.source.revision,
        evidence_paths: job.payload.source.evidencePaths ?? [],
      } : candidate)
      .filter((candidate) => validateCandidate(candidate).length === 0);
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

  const drain = (ctx: ExtensionContext) => {
    if (process.env.SHARED_KNOWLEDGE_ASYNC_EXTRACTION === "0" || !ctx.isIdle()) return;
    const cwd = ctx.cwd;
    if (busy.has(cwd) || running.has(cwd)) return;
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
      const sessionId = ctx.sessionManager.getSessionFile() ?? `memory:${ctx.cwd}`;
      const payload = createCapturedPayload(ctx.cwd, sessionId, conversation);
      const { created } = queueFor(ctx.cwd).enqueue(payload, ctx.model?.id);
      if (created) ctx.ui.setWidget("shared-knowledge", ["Knowledge extraction queued"]);
    } catch (error) {
      ctx.ui.notify(`shared-knowledge capture skipped: ${String(error)}`, "warning");
    }
  });

  pi.on("session_start", (_event, ctx) => { refreshAvailableModels(ctx); });
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
  });
}
