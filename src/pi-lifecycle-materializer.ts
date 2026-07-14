import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Candidate = Record<string, unknown>;
export type MaterializerConfig =
  | { mode: "review" }
  | { mode: "inbox" }
  | { mode: "command"; argv: string[] };

const SLUG_RE = /[^a-z0-9]+/g;

export function slugify(value: string, fallback = "candidate"): string {
  return value.toLowerCase().replace(/\.md$/, "").replace(SLUG_RE, "-")
    .replace(/^-+|-+$/g, "").slice(0, 80) || fallback;
}

export function parseMaterializerConfig(env: NodeJS.ProcessEnv = process.env): MaterializerConfig {
  const mode = (env.SHARED_KNOWLEDGE_MATERIALIZER ?? "review").trim().toLowerCase();
  if (mode === "" || mode === "review") return { mode: "review" };
  if (mode === "inbox") return { mode: "inbox" };
  if (mode !== "command") throw new Error(`Unsupported materializer mode: ${mode}`);

  const raw = env.SHARED_KNOWLEDGE_MATERIALIZER_COMMAND;
  if (!raw) throw new Error("Command materializer requires SHARED_KNOWLEDGE_MATERIALIZER_COMMAND");
  let argv: unknown;
  try {
    argv = JSON.parse(raw);
  } catch {
    throw new Error("Materializer command must be a JSON argv array");
  }
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((item) => typeof item !== "string" || !item)) {
    throw new Error("Materializer command must be a non-empty JSON string array");
  }
  return { mode: "command", argv };
}

export function validateCandidate(candidate: Candidate): string[] {
  const errors: string[] = [];
  const validTypes = new Set(["architectural-invariant", "reference", "project", "feedback"]);
  const scope = /^(workspace|module:[a-z0-9][a-z0-9-]*|capability:[a-z0-9][a-z0-9-]*)$/;
  if (!String(candidate.name ?? "").trim()) errors.push("missing name");
  if (!String(candidate.description ?? "").trim()) errors.push("missing description");
  if (!validTypes.has(String(candidate.type ?? "").trim())) errors.push("invalid type");
  if (!scope.test(String(candidate.suggested_scope ?? "").trim())) errors.push("invalid suggested_scope");
  if (String(candidate.body ?? "").trim().length < 20) errors.push("body too short (<20 chars)");
  if (!String(candidate.reason ?? "").trim()) errors.push("missing reason");
  if (!String(candidate.candidate_id ?? "").trim()) errors.push("missing candidate_id");
  return errors;
}

function renderCandidate(candidate: Candidate): string {
  const today = new Date().toISOString().slice(0, 10);
  const evidence = Array.isArray(candidate.evidence)
    ? candidate.evidence.map((item) => String(item).trim()).filter(Boolean)
    : [];
  const esc = (value: unknown) => JSON.stringify(String(value ?? "").replace(/\n/g, " ").trim());
  const lines = [
    "---",
    `name: ${esc(candidate.name)}`,
    `description: ${esc(candidate.description)}`,
    `type: ${String(candidate.type ?? "feedback").trim()}`,
    "suggested_action: retain_memory",
    `suggested_scope: ${String(candidate.suggested_scope ?? "workspace").trim()}`,
    `candidate_id: ${slugify(String(candidate.candidate_id ?? ""))}`,
    `captured_at: ${today}`,
    "capture_source: agent:compact-producer",
    "source: agent:compact-producer",
    `reason: ${esc(candidate.reason)}`,
    "---",
    "",
    String(candidate.body ?? "").trim(),
  ];
  if (evidence.length) lines.push("", "## Evidence", "", ...evidence.map((item) => `- ${item}`));
  return `${lines.join("\n")}\n`;
}

function candidateExists(inboxDir: string, id: string): boolean {
  if (!existsSync(inboxDir)) return false;
  return readdirSync(inboxDir).some((file) => {
    if (!file.endsWith(".md") || file === "README.md") return false;
    return readFileSync(join(inboxDir, file), "utf8").includes(`candidate_id: ${id}`);
  });
}

function runCommand(argv: string[], payload: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, shell: false, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`Materializer exited ${code}: ${stderr.trim()}`)));
    child.stdin.end(payload);
  });
}

export async function materializeCandidates(
  config: MaterializerConfig,
  candidates: Candidate[],
  cwd: string,
): Promise<{ mode: MaterializerConfig["mode"]; written: string[] }> {
  if (config.mode === "review") return { mode: "review", written: [] };
  if (config.mode === "command") {
    await runCommand(config.argv, `${JSON.stringify({ version: 1, cwd, candidates })}\n`, cwd);
    return { mode: "command", written: [] };
  }

  const inboxDir = join(cwd, "knowledge", "inbox");
  mkdirSync(inboxDir, { recursive: true });
  const written: string[] = [];
  for (const candidate of candidates) {
    const id = slugify(String(candidate.candidate_id ?? ""));
    if (candidateExists(inboxDir, id)) continue;
    const relative = join("knowledge", "inbox", `${new Date().toISOString().slice(0, 10)}-${id}.md`);
    writeFileSync(join(cwd, relative), renderCandidate(candidate), "utf8");
    written.push(relative);
  }
  return { mode: "inbox", written };
}
