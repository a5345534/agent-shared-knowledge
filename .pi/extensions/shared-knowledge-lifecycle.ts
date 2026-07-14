/** Checkout-safe shared-knowledge lifecycle integration for Pi. */
import { complete } from "@earendil-works/pi-ai/compat";
import { convertToLlm, serializeConversation, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  materializeCandidates,
  parseMaterializerConfig,
  validateCandidate,
  type Candidate,
} from "../../src/pi-lifecycle-materializer.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROMPT_FILE = join(PACKAGE_ROOT, ".pi", "prompts", "compact-review.md");
const ABSORBER_SCRIPT = join(PACKAGE_ROOT, "scripts", "knowledge_absorb.py");
const ABSORBER_TIMEOUT_MS = 60_000;

function responseText(content: Array<{ type: string; text?: string }>): string {
  return content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n")
    .replace(/^```(?:json)?\n?/i, "").replace(/\n?```\s*$/, "").trim();
}

export default function sharedKnowledgeLifecycle(pi: ExtensionAPI) {
  pi.on("session_before_compact", async (event, ctx) => {
    const messages = event.preparation.messagesToSummarize;
    if (messages.length === 0) return;

    let materializer;
    try {
      materializer = parseMaterializerConfig();
    } catch (error) {
      ctx.ui.notify(`shared-knowledge: ${String(error)}`, "warning");
      return;
    }

    const model = ctx.model;
    if (!model) {
      ctx.ui.notify("shared-knowledge: no active model; extraction skipped", "warning");
      return;
    }
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || (!auth.apiKey && Object.keys(auth.headers ?? {}).length === 0)) {
      ctx.ui.notify(`shared-knowledge: credentials unavailable for ${model.id}`, "warning");
      return;
    }

    ctx.ui.setStatus("shared-knowledge", "Reviewing session…");
    try {
      const prompt = existsSync(PROMPT_FILE)
        ? readFileSync(PROMPT_FILE, "utf8")
        : "Extract durable shared-knowledge candidates as JSON with a candidates array.";
      const conversation = serializeConversation(convertToLlm(messages));
      const response = await complete(model, {
        messages: [{
          role: "user",
          content: [{
            type: "text",
            text: `${prompt}\n\nReview this conversation:\n\n${conversation}`,
          }],
          timestamp: Date.now(),
        }],
      }, {
        apiKey: auth.apiKey,
        headers: auth.headers,
        maxTokens: 4096,
        signal: event.signal,
      });

      let parsed: { candidates?: Candidate[] };
      try {
        parsed = JSON.parse(responseText(response.content));
      } catch {
        ctx.ui.notify("shared-knowledge: model returned invalid candidate JSON", "warning");
        return;
      }
      const candidates = Array.isArray(parsed.candidates)
        ? parsed.candidates.filter((candidate) => validateCandidate(candidate).length === 0)
        : [];
      if (candidates.length === 0) {
        ctx.ui.setWidget("shared-knowledge", ["No valid shared-knowledge candidates found"]);
        return;
      }

      const result = await materializeCandidates(materializer, candidates, ctx.cwd);
      const detail = result.mode === "review"
        ? `${candidates.length} candidate(s) reviewed; checkout unchanged (no materializer configured)`
        : result.mode === "command"
          ? `${candidates.length} candidate(s) delegated to external materializer`
          : `${result.written.length} candidate(s) written by explicit inbox materializer`;
      ctx.ui.setWidget("shared-knowledge", [detail]);
      ctx.ui.notify(`shared-knowledge: ${detail}`, "info");
    } catch (error) {
      ctx.ui.notify(`shared-knowledge extraction failed: ${String(error)}`, "warning");
    } finally {
      ctx.ui.setStatus("shared-knowledge", undefined);
    }
  });

  pi.on("session_compact", async (_event, ctx) => {
    let materializer;
    try {
      materializer = parseMaterializerConfig();
    } catch {
      return;
    }
    if (materializer.mode !== "inbox" || !existsSync(ABSORBER_SCRIPT)) return;

    const child = spawn("python3", [
      ABSORBER_SCRIPT,
      "--root", ctx.cwd,
      "hook",
      "--format", "json",
      "--git-mode", "none",
    ], { cwd: ctx.cwd, detached: true, stdio: "ignore", timeout: ABSORBER_TIMEOUT_MS });
    child.unref();
  });
}
