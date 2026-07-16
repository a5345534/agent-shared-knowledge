export type CandidateEnvelope<T = unknown> = { candidates: T[] };

export class CandidateResponseParseError extends Error {
  constructor(readonly diagnostic: string) {
    super(`Model returned invalid candidate JSON (${diagnostic})`);
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

function isEnvelope(value: unknown): value is CandidateEnvelope {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Array.isArray((value as { candidates?: unknown }).candidates);
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
    `bytes=${bytes}`,
    `fenced=${hasFence ? "yes" : "no"}`,
    `balancedObjects=${objectCandidates.length}`,
    `unterminatedFence=${fenceCount % 2 === 1 ? "yes" : "no"}`,
  ].join(",");
  throw new CandidateResponseParseError(diagnostic.slice(0, 200));
}

export function extractionRetryInstruction(attempts: number, lastError?: string): string {
  if (attempts <= 0 || !/invalid candidate JSON/i.test(lastError ?? "")) return "";
  return [
    "A previous extraction attempt returned invalid JSON.",
    "Return exactly one JSON object with a candidates array.",
    "Do not use Markdown fences, a preamble, or trailing commentary.",
  ].join(" ");
}
