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
  createCapturedPayload,
  isMeaningfulConversation,
  normalizeConversation,
  parseQueueConfig,
  type KnowledgeJob,
} from "../../src/knowledge-job-runtime.ts";
import {
  materializeCandidates,
  parseMaterializerConfig,
  validateCandidate,
  type Candidate,
} from "../../src/pi-lifecycle-materializer.ts";
import {
  formatModelPolicy,
  globalConfigPath,
  modelArgumentCompletions,
  parseKnowledgeModelArgs,
  readConfig,
  requireModelAuthentication,
  resetConfig,
  resolveEffectiveModel,
  selectExtractionModel,
  summarizeQueue,
  workspaceConfigPath,
  writeConfig,
  type ConfigScope,
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
  const sessionPolicies = new Map<object | string, ModelPolicy>();
  let availableModels: Array<{ provider: string; id: string }> = [];
  const queueFor = (cwd: string) => {
    let queue = queues.get(cwd);
    if (!queue) {
      queue = new KnowledgeJobQueue(cwd);
      queue.recoverRunning();
      queues.set(cwd, queue);
    }
    return queue;
  };
  const sessionPolicyFor = (ctx: ExtensionContext) => {
    const direct = sessionPolicies.get(ctx.sessionManager);
    const file = ctx.sessionManager.getSessionFile();
    return direct ?? (file ? sessionPolicies.get(file) : undefined);
  };
  const effectiveFor = (ctx: ExtensionContext) => resolveEffectiveModel({
    session: sessionPolicyFor(ctx),
    workspace: readConfig(workspaceConfigPath(ctx.cwd)),
    global: readConfig(globalConfigPath(getAgentDir())),
  });
  const refreshAvailableModels = (ctx: ExtensionContext) => {
    availableModels = ctx.modelRegistry.getAvailable().map((model) => ({ provider: model.provider, id: model.id }));
    return availableModels;
  };
  const updateScope = (ctx: ExtensionContext, scope: ConfigScope, policy?: ModelPolicy) => {
    if (scope === "session") {
      const file = ctx.sessionManager.getSessionFile();
      if (policy) {
        sessionPolicies.set(ctx.sessionManager, policy);
        if (file) sessionPolicies.set(file, policy);
      } else {
        sessionPolicies.delete(ctx.sessionManager);
        if (file) sessionPolicies.delete(file);
      }
      return;
    }
    const path = scope === "workspace" ? workspaceConfigPath(ctx.cwd) : globalConfigPath(getAgentDir());
    if (policy) writeConfig(path, policy);
    else resetConfig(path);
  };
  const permitInactiveWrite = async (ctx: ExtensionContext, allowInactive: boolean, interactive: boolean) => {
    const effective = effectiveFor(ctx);
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
    const effective = effectiveFor(ctx);
    const queue = queueFor(ctx.cwd);
    const counts = summarizeQueue(queue.list());
    const configured = effective.policy ? formatModelPolicy(effective.policy) : "invalid environment value";
    const activeDetail = effective.policy?.mode === "active"
      ? ` → ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no active model"}`
      : "";
    let materializer = "invalid";
    try { materializer = parseMaterializerConfig().mode; } catch { /* bounded status only */ }
    return [
      `Extraction model: ${configured}${activeDetail}`,
      `Source: ${effective.source}${effective.locked ? " (locked by environment)" : ""}`,
      effective.error ? `Error: ${effective.error.slice(0, 240)}` : undefined,
      `Materializer: ${materializer}`,
      `Runtime: ${queue.root}`,
      `Jobs: pending=${counts.pending} running=${counts.running} retry-wait=${counts["retry-wait"]} failed=${counts.failed} review-ready=${counts["review-ready"]}`,
      ...effective.diagnostics.map((diagnostic) => `Warning: ${diagnostic}`),
    ].filter((line): line is string => Boolean(line)).join("\n");
  };
  const showStatus = (ctx: ExtensionContext) => ctx.ui.notify(statusText(ctx), "info");
  const chooseScope = async (ctx: ExtensionContext): Promise<ConfigScope | undefined> => {
    const selected = await ctx.ui.select("Configuration scope", ["session", "workspace", "global"]);
    return selected as ConfigScope | undefined;
  };
  const configureInteractively = async (ctx: ExtensionContext, reset = false) => {
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
    if (!await permitInactiveWrite(ctx, false, true)) return;
    updateScope(ctx, scope, policy);
    ctx.ui.notify(`Shared Knowledge ${reset ? "reset" : "model saved"} for ${scope}.\n${statusText(ctx)}`, "info");
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
        if (!parsed.action) return configureInteractively(ctx);
        if (!await permitInactiveWrite(ctx, parsed.allowInactive, false)) return;
        if (parsed.policy?.mode === "fixed") {
          const fixedPolicy = parsed.policy;
          const known = ctx.modelRegistry.getAvailable().some((model) => model.provider === fixedPolicy.provider && model.id === fixedPolicy.modelId);
          if (!known) throw new Error(`model is unavailable or unauthenticated: ${formatModelPolicy(fixedPolicy)}`);
        }
        updateScope(ctx, parsed.scope, parsed.policy);
        ctx.ui.notify(`Shared Knowledge ${parsed.action === "reset" ? "reset" : "model saved"} for ${parsed.scope}.\n${statusText(ctx)}`, "info");
      } catch (error) {
        ctx.ui.notify(`shared-knowledge config: ${String(error).slice(0, 300)}`, "error");
      }
    },
  });
  pi.registerCommand("knowledge-config", {
    description: "Open Shared Knowledge configuration",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return showStatus(ctx);
      const action = await ctx.ui.select("Shared Knowledge configuration", ["Change extraction model", "Reset a scope", "Show status"]);
      if (action === "Change extraction model") await configureInteractively(ctx);
      else if (action === "Reset a scope") await configureInteractively(ctx, true);
      else if (action === "Show status") showStatus(ctx);
    },
  });
  pi.registerCommand("knowledge-status", {
    description: "Show effective Shared Knowledge background configuration and queue counts",
    handler: async (_args, ctx) => showStatus(ctx),
  });

  const processOne = async (ctx: ExtensionContext, queue: KnowledgeJobQueue, job: KnowledgeJob) => {
    if (!job.payload || !isMeaningfulConversation(job.payload.conversation)) {
      queue.update(job.id, { state: "skipped", error: undefined });
      return;
    }
    const effective = effectiveFor(ctx);
    const model = selectExtractionModel(effective, ctx.model, (provider, modelId) => ctx.modelRegistry.find(provider, modelId));
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
    const materializer = parseMaterializerConfig();
    const result = await materializeCandidates(materializer, candidates, ctx.cwd);
    if (result.mode === "inbox" && result.written.length > 0) await runAbsorber(ctx.cwd);
    if (job.payload.source) {
      await runSourceAck(ctx.cwd, job.payload.source.instanceId, job.payload.source.runId);
    }
    const state = result.mode === "review" ? "review-ready" : "done";
    queue.update(job.id, {
      state,
      error: undefined,
      payload: undefined,
      result: {
        candidateCount: candidates.length,
        materializer: result.mode,
        written: result.written,
        reviewCandidates: result.mode === "review" ? candidates : undefined,
      },
    });
    const detail = result.mode === "review"
      ? `${candidates.length} background candidate(s) ready for review; checkout unchanged`
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
        const outcome = queue.read(first.id);
        for (const item of batch.slice(1)) {
          queue.update(item.id, {
            state: outcome?.state ?? "done",
            error: outcome?.error,
            payload: undefined,
            result: outcome?.result,
          });
        }
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

  const schedule = (ctx: ExtensionContext) => {
    const cwd = ctx.cwd;
    const previous = timers.get(cwd);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      timers.delete(cwd);
      drain(ctx);
    }, parseQueueConfig().debounceMs);
    timer.unref();
    timers.set(cwd, timer);
  };

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
    sessionPolicies.delete(ctx.sessionManager);
    const file = ctx.sessionManager.getSessionFile();
    if (file) sessionPolicies.delete(file);
  });
}
