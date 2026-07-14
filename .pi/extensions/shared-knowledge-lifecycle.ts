/**
 * Shared Knowledge Lifecycle Extension
 *
 * Lifecycle:
 *   1. session_before_compact -> call LLM via Pi's provider, write inbox
 *   2. session_compact       -> run inbox absorber (detached)
 *
 * Installed as Pi Package (agent-shared-knowledge).
 * Discovers its own package root via import.meta.url.
 */
import { complete } from "@earendil-works/pi-ai/compat";
import {
  serializeConversation,
  convertToLlm,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Discover package root relative to this extension file
const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = join(EXT_DIR, "..", "..");
const SCRIPTS_DIR = join(PKG_DIR, "scripts");
const PROMPTS_DIR = join(PKG_DIR, ".pi", "prompts");

const PROMPT_FILE = join(PROMPTS_DIR, "compact-review.md");
const ABSORBER_SCRIPT = join(SCRIPTS_DIR, "knowledge_absorb.py");
const ABSORBER_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Candidate helpers
// ---------------------------------------------------------------------------
const VALID_MEMORY_TYPES = new Set([
  "architectural-invariant", "reference", "project", "feedback",
]);
const VALID_SCOPE_RE = /^(workspace|module:[a-z0-9][a-z0-9-]*|capability:[a-z0-9][a-z0-9-]*)$/;
const SLUG_RE = /[^a-z0-9]+/g;

function slugify(value: string, fallback = "candidate"): string {
  return value.toLowerCase()
    .replace(/\.md$/, "")
    .replace(SLUG_RE, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || fallback;
}

function validateCandidate(c: Record<string, unknown>): string[] {
  const e: string[] = [];
  if (!String(c.name ?? "").trim()) e.push("missing name");
  if (!String(c.description ?? "").trim()) e.push("missing description");
  const t = String(c.type ?? "").trim();
  if (!VALID_MEMORY_TYPES.has(t)) e.push("invalid type: " + t);
  if (!VALID_SCOPE_RE.test(String(c.suggested_scope ?? "").trim())) e.push("invalid suggested_scope");
  if (String(c.body ?? "").trim().length < 20) e.push("body too short (<20 chars)");
  if (!String(c.reason ?? "").trim()) e.push("missing reason");
  if (!String(c.candidate_id ?? "").trim()) e.push("missing candidate_id");
  return e;
}

function renderCandidate(c: Record<string, unknown>): string {
  const today = new Date().toISOString().slice(0, 10);
  const ev = Array.isArray(c.evidence)
    ? c.evidence.map((x: unknown) => String(x).trim()).filter(Boolean)
    : [];
  const esc = (v: unknown) => JSON.stringify(String(v ?? "").replace(/\n/g, " ").trim());
  let md = "---\n";
  md += "name: " + esc(c.name) + "\n";
  md += "description: " + esc(c.description) + "\n";
  md += "type: " + String(c.type ?? "feedback").trim() + "\n";
  md += "suggested_action: retain_memory\n";
  md += "suggested_scope: " + String(c.suggested_scope ?? "workspace").trim() + "\n";
  md += "candidate_id: " + slugify(String(c.candidate_id ?? ""), "candidate") + "\n";
  md += "captured_at: " + today + "\n";
  md += "capture_source: agent:compact-producer\n";
  md += "source: agent:compact-producer\n";
  md += "reason: " + esc(c.reason) + "\n";
  md += "---\n\n";
  md += String(c.body ?? "").trim() + "\n";
  if (ev.length > 0) {
    md += "\n## Evidence\n\n";
    for (const x of ev) md += "- " + x + "\n";
  }
  md += "\n";
  return md;
}

function candidateExists(inboxDir: string, cid: string): boolean {
  if (!existsSync(inboxDir)) return false;
  for (const f of readdirSync(inboxDir)) {
    if (!f.endsWith(".md") || f === "README.md") continue;
    const text = readFileSync(join(inboxDir, f), "utf-8");
    const m = text.match(/^---\n([\s\S]*?)\n---/);
    if (!m) continue;
    for (const line of m[1].split("\n")) {
      if (line.startsWith("candidate_id:")) {
        const id = line.split(":").slice(1).join(":").trim().replace(/^"|"$/g, "");
        if (id === cid) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------
export default function (pi: ExtensionAPI) {
  pi.on("session_before_compact", async (_event, ctx) => {
    const inboxDir = join(ctx.cwd, "knowledge", "inbox");
    mkdirSync(inboxDir, { recursive: true });

    const promptPath = PROMPT_FILE;
    if (!existsSync(promptPath)) {
      ctx.ui.notify(`shared-knowledge: compact prompt not found at ${promptPath}`, "warn");
      return;
    }
    const promptTemplate = readFileSync(promptPath, "utf-8");

    const session = ctx.sessionManager;
    const entries = session.getEntries();
    const conversation = serializeConversation(entries);
    const messages = convertToLlm(conversation, { cwd: ctx.cwd });

    const result = await complete(
      [
        { role: "system", content: promptTemplate },
        ...messages.slice(-40),
        {
          role: "user",
          content:
            "Review the recent conversation and extract 2-5 durable facts " +
            "as JSON. See the system prompt for the required schema and rules.",
        },
      ],
      {
        model: "default",
        responseSchema: {
          type: "object",
          properties: {
            candidates: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  candidate_id: { type: "string" },
                  name: { type: "string" },
                  description: { type: "string" },
                  type: {
                    type: "string",
                    enum: ["architectural-invariant", "reference", "project", "feedback"],
                  },
                  suggested_scope: { type: "string" },
                  body: { type: "string" },
                  reason: { type: "string" },
                  evidence: {
                    type: "array",
                    items: { type: "string" },
                  },
                },
                required: ["candidate_id", "name", "description", "type", "suggested_scope", "body", "reason"],
              },
            },
          },
          required: ["candidates"],
        },
      },
    );

    const data = result as { candidates?: Record<string, unknown>[] };
    if (!data?.candidates?.length) {
      ctx.ui.setWidget("shared-knowledge", ["No candidates generated"]);
      return;
    }

    const valid: Record<string, unknown>[] = [];
    for (const c of data.candidates) {
      const errors = validateCandidate(c);
      if (errors.length > 0) {
        ctx.ui.setWidget("shared-knowledge", [
          `Skipped candidate ${c.candidate_id ?? "(unnamed)"}: ${errors.join(", ")}`,
        ]);
        continue;
      }
      valid.push(c);
    }

    if (valid.length === 0) {
      ctx.ui.setWidget("shared-knowledge", ["No valid candidates generated"]);
      return;
    }

    for (const c of valid) {
      const cid = slugify(String(c.candidate_id ?? ""), "candidate");
      if (candidateExists(inboxDir, cid)) continue;
      const filePath = join(inboxDir, `${cid}.md`);
      writeFileSync(filePath, renderCandidate(c), "utf-8");
    }

    const status = `Generated ${valid.length} candidate(s) in knowledge/inbox/`;
    ctx.ui.setWidget("shared-knowledge", [status]);
    ctx.ui.notify(`shared-knowledge: ${status}`, "info");
  });

  pi.on("session_compact", async (_event, ctx) => {
    const absorberScript = ABSORBER_SCRIPT;
    if (!existsSync(absorberScript)) {
      return; // Not installed as Pi Package; skip
    }

    const child = spawn(
      "python3",
      [absorberScript, "--root", ctx.cwd, "hook"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: ABSORBER_TIMEOUT_MS,
        detached: true,
      },
    );
    child.unref();

    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    child.on("close", (code) => {
      if (code !== 0) {
        ctx.ui.notify(`shared-knowledge: absorber exited with code ${code}`, "warn");
      }
    });
  });
}
