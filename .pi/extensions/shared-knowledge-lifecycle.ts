/** Checkout-safe, non-blocking shared-knowledge lifecycle integration for Pi. */
import { complete } from "@earendil-works/pi-ai/compat";
import { convertToLlm, serializeConversation, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROMPT_FILE = join(PACKAGE_ROOT, ".pi", "prompts", "compact-review.md");
const ABSORBER_SCRIPT = join(PACKAGE_ROOT, "scripts", "knowledge_absorb.py");
const SOURCES_SCRIPT = join(PACKAGE_ROOT, "scripts", "knowledge_sources.py");
const running = new Set<string>();
const timers = new Map<string, NodeJS.Timeout>();
const busy = new Set<string>();

function responseText(content: Array<{ type: string; text?: string }>): string {
  return content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n")
    .replace(/^```(?:json)?\n?/i, "").replace(/\n?```\s*$/, "").trim();
}

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
  const queueFor = (cwd: string) => {
    let queue = queues.get(cwd);
    if (!queue) {
      queue = new KnowledgeJobQueue(cwd);
      queue.recoverRunning();
      queues.set(cwd, queue);
    }
    return queue;
  };

  const processOne = async (ctx: ExtensionContext, queue: KnowledgeJobQueue, job: KnowledgeJob) => {
    if (!job.payload || !isMeaningfulConversation(job.payload.conversation)) {
      queue.update(job.id, { state: "skipped", error: undefined });
      return;
    }
    const configuredModel = process.env.SHARED_KNOWLEDGE_EXTRACTION_MODEL?.trim();
    const [provider, modelId] = configuredModel?.includes("/") ? configuredModel.split("/", 2) : [];
    const model = provider && modelId ? ctx.modelRegistry.find(provider, modelId) : ctx.model;
    if (!model) throw new Error(configuredModel ? `Configured extraction model is unavailable: ${configuredModel}` : "No active model available");
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || (!auth.apiKey && Object.keys(auth.headers ?? {}).length === 0)) {
      throw new Error(`Credentials unavailable for ${model.id}`);
    }
    queue.update(job.id, { state: "running", modelHint: model.id, error: undefined });
    const response = await complete(model, {
      messages: [{
        role: "user",
        content: [{ type: "text", text: `${promptText()}\n\nReview this conversation:\n\n${job.payload.conversation}` }],
        timestamp: Date.now(),
      }],
    }, { apiKey: auth.apiKey, headers: auth.headers, maxTokens: 4096 });

    let parsed: { candidates?: Candidate[] };
    try {
      parsed = JSON.parse(responseText(response.content));
    } catch {
      throw new Error("Model returned invalid candidate JSON");
    }
    const candidates = Array.isArray(parsed.candidates)
      ? parsed.candidates
        .map((candidate) => job.payload?.source ? {
          ...candidate,
          capture_source: `source:${job.payload.source.instanceId}`,
          source_instance: job.payload.source.instanceId,
          source_run_id: job.payload.source.runId,
          evidence_snapshot: job.payload.source.snapshot,
          source_revision: job.payload.source.revision,
          evidence_paths: job.payload.source.evidencePaths ?? [],
        } : candidate)
        .filter((candidate) => validateCandidate(candidate).length === 0)
      : [];
    const materializer = parseMaterializerConfig();
    const result = await materializeCandidates(materializer, candidates, ctx.cwd);
    if (result.mode === "inbox" && result.written.length > 0) await runAbsorber(ctx.cwd);
    if (job.payload.source && (result.mode !== "inbox" || result.written.length > 0 || candidates.length === 0)) {
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
        for (const item of batch) queue.markRetry(item.id, error);
        ctx.ui.notify(`shared-knowledge background extraction deferred: ${String(error)}`, "warning");
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
  });
}
