import assert from "node:assert/strict";
import test from "node:test";
import {
  CANDIDATE_SUBMISSION_TOOL_NAME,
  CandidateResponseParseError,
  extractionFailureNotice,
  extractionRetryInstruction,
  parseCandidateAssistantResponse,
  parseCandidateResponse,
} from "../src/candidate-response.ts";

test("candidate response parses direct and fenced JSON", () => {
  assert.deepEqual(parseCandidateResponse('{"candidates":[]}'), { candidates: [] });
  assert.deepEqual(
    parseCandidateResponse('```json\n{"candidates":[{"candidate_id":"one"}]}\n```'),
    { candidates: [{ candidate_id: "one" }] },
  );
});

test("candidate response isolates a balanced envelope from prose", () => {
  const response = [
    "Here is the requested result.",
    '{"candidates":[{"body":"brace } and escaped \\\" quote"}]}',
    "This trailing explanation must not break extraction.",
  ].join("\n");
  assert.deepEqual(parseCandidateResponse(response), {
    candidates: [{ body: 'brace } and escaped " quote' }],
  });
});

test("candidate response skips unrelated JSON before the envelope", () => {
  const response = '{"status":"ok"}\n{"candidates":[{"candidate_id":"two"}]}';
  assert.deepEqual(parseCandidateResponse(response), {
    candidates: [{ candidate_id: "two" }],
  });
});

test("candidate response rejects malformed output with content-free diagnostics", () => {
  assert.throws(
    () => parseCandidateResponse("```json\n{not valid"),
    (error: unknown) => {
      assert.ok(error instanceof CandidateResponseParseError);
      assert.match(error.message, /bytes=\d+,fenced=yes,balancedObjects=0,unterminatedFence=yes/);
      assert.equal(error.message.includes("not valid"), false);
      return true;
    },
  );
});

test("assistant response prefers structured candidate tool arguments", () => {
  const parsed = parseCandidateAssistantResponse([
    { type: "text", text: "this prose is intentionally not JSON" },
    {
      type: "toolCall",
      name: CANDIDATE_SUBMISSION_TOOL_NAME,
      arguments: { candidates: [{ candidate_id: "structured" }] },
    },
  ], "toolUse");
  assert.deepEqual(parsed, { candidates: [{ candidate_id: "structured" }] });
});

test("assistant response falls back to bounded text envelope", () => {
  const parsed = parseCandidateAssistantResponse([
    { type: "toolCall", name: "unrelated_tool", arguments: { secret: "ignored" } },
    { type: "text", text: "Result:\n```json\n{\"candidates\":[]}\n```" },
  ], "stop");
  assert.deepEqual(parsed, { candidates: [] });
});

test("assistant response diagnostics include shape and stop reason without content", () => {
  assert.throws(
    () => parseCandidateAssistantResponse([
      { type: "text", text: "```json\n{private malformed output\n```" },
      { type: "toolCall", name: CANDIDATE_SUBMISSION_TOOL_NAME, arguments: { private: "argument" } },
    ], "length"),
    (error: unknown) => {
      assert.ok(error instanceof CandidateResponseParseError);
      assert.match(error.message, /stopReason=length,blocks=2,textBlocks=1,toolCalls=1/);
      assert.equal(error.message.includes("private malformed output"), false);
      assert.equal(error.message.includes("argument"), false);
      assert.ok(error.message.length < 400);
      return true;
    },
  );
});

test("failure notices distinguish retry-wait from terminal failure", () => {
  const deferred = extractionFailureNotice("retry-wait", 1, "a".repeat(24), "parse failed");
  assert.equal(deferred.level, "warning");
  assert.match(deferred.message, /deferred and will retry/);
  const failed = extractionFailureNotice("failed", 3, "b".repeat(24), "private response");
  assert.equal(failed.level, "error");
  assert.match(failed.message, /failed after 3 attempts/);
  assert.match(failed.message, /knowledge-jobs --root <workspace> retry/);
  assert.equal(failed.message.includes("private response"), false);
});

test("retry instruction changes only parse-failure retries", () => {
  assert.equal(extractionRetryInstruction(0, "Model returned invalid candidate JSON"), "");
  assert.equal(extractionRetryInstruction(1, "Background extraction timed out"), "");
  assert.match(
    extractionRetryInstruction(1, "Model returned invalid candidate JSON (bytes=10)"),
    /Return exactly one JSON object/,
  );
  assert.match(
    extractionRetryInstruction(2, "Model returned invalid candidate JSON"),
    /Do not use Markdown fences/,
  );
});
