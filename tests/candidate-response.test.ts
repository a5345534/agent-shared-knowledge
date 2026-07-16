import assert from "node:assert/strict";
import test from "node:test";
import {
  CandidateResponseParseError,
  extractionRetryInstruction,
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
