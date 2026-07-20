/**
 * `feedback_findings` is deliberately optional and independently validated by
 * the feedback runtime. Candidate extraction remains compatible with older
 * envelopes that contain only `candidates`.
 */
export type CandidateEnvelope<T = unknown, F = unknown> = { candidates: T[]; feedback_findings?: F[] };
export const CANDIDATE_SUBMISSION_TOOL_NAME = "submit_shared_knowledge_candidates";
const MAX_TOOL_ARGUMENT_BYTES = 1024 * 1024;

export type CandidateResponseFailureKind =
  | "text-json-invalid"
  | "tool-arguments-normalized-empty"
  | "tool-arguments-unavailable"
  | "tool-arguments-malformed-string"
  | "tool-arguments-too-large"
  | "tool-arguments-unsupported"
  | "tool-envelope-missing-candidates"
  | "unexpected-tool";

type ResponseBlock =
  | { type: "text"; text?: string }
  | { type: "thinking" }
  | { type: "toolCall"; name?: string; arguments?: unknown };

type ToolFailure = {
  kind: Exclude<CandidateResponseFailureKind, "text-json-invalid" | "unexpected-tool">;
  argumentShape: "empty-object" | "missing" | "malformed-string" | "oversized-string" | "unsupported" | "object" | "string";
};

export class CandidateResponseParseError extends Error {
  constructor(readonly kind: CandidateResponseFailureKind, readonly diagnostic: string) {
    super(`Model returned invalid candidate submission (${diagnostic})`);
    this.name = "CandidateResponseParseError";
  }
}

function stripOuterFence(value: string): string {
  const match = /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i.exec(value);
  return match?.[1]?.trim() ?? value.trim();
}

function balancedObjects(value: string): string[] {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(value.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return objects;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnvelope(value: unknown): value is CandidateEnvelope {
  return isRecord(value) && Array.isArray(value.candidates);
}

function decodeToolArguments(value: unknown): { envelope?: CandidateEnvelope; failure?: ToolFailure } {
  if (isEnvelope(value)) return { envelope: value };
  if (isRecord(value)) {
    return Object.keys(value).length === 0
      ? { failure: { kind: "tool-arguments-normalized-empty", argumentShape: "empty-object" } }
      : { failure: { kind: "tool-envelope-missing-candidates", argumentShape: "object" } };
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > MAX_TOOL_ARGUMENT_BYTES) {
      return { failure: { kind: "tool-arguments-too-large", argumentShape: "oversized-string" } };
    }
    if (!value.trim()) {
      return { failure: { kind: "tool-arguments-unavailable", argumentShape: "missing" } };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return { failure: { kind: "tool-arguments-malformed-string", argumentShape: "malformed-string" } };
    }
    if (isEnvelope(parsed)) return { envelope: parsed };
    return { failure: { kind: "tool-envelope-missing-candidates", argumentShape: "string" } };
  }
  if (value === undefined || value === null) {
    return { failure: { kind: "tool-arguments-unavailable", argumentShape: "missing" } };
  }
  return { failure: { kind: "tool-arguments-unsupported", argumentShape: "unsupported" } };
}

export function parseCandidateResponse<T = unknown>(raw: string): CandidateEnvelope<T> {
  const text = raw.trim();
  const fenced = [...text.matchAll(/```(?:json)?\s*\n?([\s\S]*?)\n?```/gi)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
  const objectCandidates = balancedObjects(text);
  const candidates = [stripOuterFence(text), ...fenced, ...objectCandidates];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (isEnvelope(parsed)) return parsed as CandidateEnvelope<T>;
    } catch {
      // Try the next mechanically isolated candidate without retaining content.
    }
  }

  const bytes = Buffer.byteLength(text);
  const hasFence = text.includes("```");
  const fenceCount = (text.match(/```/g) ?? []).length;
  const diagnostic = [
    "kind=text-json-invalid",
    `bytes=${bytes}`,
    `fenced=${hasFence ? "yes" : "no"}`,
    `balancedObjects=${objectCandidates.length}`,
    `unterminatedFence=${fenceCount % 2 === 1 ? "yes" : "no"}`,
  ].join(",");
  throw new CandidateResponseParseError("text-json-invalid", diagnostic.slice(0, 240));
}

export function parseCandidateAssistantResponse<T = unknown>(
  content: ResponseBlock[],
  stopReason: string,
): CandidateEnvelope<T> {
  const toolCalls = content.filter((block): block is Extract<ResponseBlock, { type: "toolCall" }> => block.type === "toolCall");
  const expected = toolCalls.filter((block) => block.name === CANDIDATE_SUBMISSION_TOOL_NAME);
  let failure: ToolFailure | undefined;
  for (const block of expected) {
    const decoded = decodeToolArguments(block.arguments);
    if (decoded.envelope) return decoded.envelope as CandidateEnvelope<T>;
    failure ??= decoded.failure;
  }

  const textBlocks = content.filter((block): block is Extract<ResponseBlock, { type: "text" }> => block.type === "text");
  const text = textBlocks.map((block) => block.text ?? "").join("\n");
  if (text.trim()) {
    try {
      return parseCandidateResponse<T>(text);
    } catch (error) {
      const base = error instanceof CandidateResponseParseError ? error.diagnostic : "kind=text-json-invalid";
      const diagnostic = `${base},stopReason=${stopReason || "unknown"},blocks=${content.length},textBlocks=${textBlocks.length},toolCalls=${toolCalls.length},expectedToolCalls=${expected.length}`;
      throw new CandidateResponseParseError("text-json-invalid", diagnostic.slice(0, 360));
    }
  }

  if (failure) {
    const diagnostic = `kind=${failure.kind},stopReason=${stopReason || "unknown"},blocks=${content.length},textBlocks=${textBlocks.length},toolCalls=${toolCalls.length},expectedToolCalls=${expected.length},argumentShape=${failure.argumentShape}`;
    throw new CandidateResponseParseError(failure.kind, diagnostic.slice(0, 360));
  }
  if (toolCalls.length > 0) {
    const diagnostic = `kind=unexpected-tool,stopReason=${stopReason || "unknown"},blocks=${content.length},textBlocks=${textBlocks.length},toolCalls=${toolCalls.length},expectedToolCalls=0`;
    throw new CandidateResponseParseError("unexpected-tool", diagnostic.slice(0, 360));
  }

  try {
    return parseCandidateResponse<T>(text);
  } catch (error) {
    const base = error instanceof CandidateResponseParseError ? error.diagnostic : "kind=text-json-invalid";
    const diagnostic = `${base},stopReason=${stopReason || "unknown"},blocks=${content.length},textBlocks=${textBlocks.length},toolCalls=0,expectedToolCalls=0`;
    throw new CandidateResponseParseError("text-json-invalid", diagnostic.slice(0, 360));
  }
}

export function extractionFailureNotice(
  state: "retry-wait" | "failed",
  attempts: number,
  jobId: string,
  error: unknown,
): { message: string; level: "warning" | "error" } {
  if (state === "failed") {
    return {
      message: `shared-knowledge background extraction failed after ${attempts} attempts. Retained job ${jobId} can be retried with: knowledge-jobs --root <workspace> retry ${jobId}`,
      level: "error",
    };
  }
  return {
    message: `shared-knowledge background extraction deferred and will retry: ${String(error)}`,
    level: "warning",
  };
}

function structuredFailure(lastError: string): boolean {
  return /kind=(?:tool-|unexpected-tool)/i.test(lastError)
    || /stopReason=toolUse[^)]*textBlocks=0[^)]*toolCalls=[1-9]/i.test(lastError);
}

export function extractionRetryInstruction(attempts: number, lastError?: string): string {
  if (attempts <= 0) return "";
  const error = lastError ?? "";
  if (structuredFailure(error)) {
    return attempts === 1
      ? `A previous structured submission was unusable. Call ${CANDIDATE_SUBMISSION_TOOL_NAME} exactly once with an arguments object containing a candidates array; use an empty array when no durable candidates exist.`
      : `The previous required tool call was still structurally unusable. Return no prose. Call ${CANDIDATE_SUBMISSION_TOOL_NAME} exactly once with arguments shaped exactly as {"candidates":[]}, replacing the empty array only with valid candidate objects.`;
  }
  if (!/(?:invalid candidate JSON|kind=text-json-invalid|invalid candidate submission)/i.test(error)) return "";
  return [
    "A previous extraction attempt returned invalid JSON.",
    "Return exactly one JSON object with a candidates array.",
    "Do not use Markdown fences, a preamble, or trailing commentary.",
  ].join(" ");
}
