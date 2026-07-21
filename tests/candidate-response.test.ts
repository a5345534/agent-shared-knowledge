import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CANDIDATE_SUBMISSION_TOOL_NAME,
  CandidateResponseParseError,
  extractionFailureNotice,
  extractionRetryInstruction,
  parseCandidateAssistantResponse,
  parseCandidateResponse,
} from "../src/candidate-response.ts";
import { createCapturedPayload, KnowledgeJobQueue } from "../src/knowledge-job-runtime.ts";

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
      assert.equal(error.kind, "text-json-invalid");
      assert.match(error.message, /kind=text-json-invalid,bytes=\d+,fenced=yes,balancedObjects=0,unterminatedFence=yes/);
      assert.equal(error.message.includes("not valid"), false);
      return true;
    },
  );
});

test("assistant response accepts structured object and bounded JSON-string arguments", () => {
  const objectParsed = parseCandidateAssistantResponse([
    { type: "text", text: "this prose is intentionally not JSON" },
    {
      type: "toolCall",
      name: CANDIDATE_SUBMISSION_TOOL_NAME,
      arguments: { candidates: [{ candidate_id: "structured" }] },
    },
  ], "toolUse");
  assert.deepEqual(objectParsed, { candidates: [{ candidate_id: "structured" }] });

  const stringParsed = parseCandidateAssistantResponse([{
    type: "toolCall",
    name: CANDIDATE_SUBMISSION_TOOL_NAME,
    arguments: '{"candidates":[{"candidate_id":"string-envelope"}]}',
  }], "toolUse");
  assert.deepEqual(stringParsed, { candidates: [{ candidate_id: "string-envelope" }] });

  assert.throws(
    () => parseCandidateAssistantResponse([{
      type: "toolCall",
      name: CANDIDATE_SUBMISSION_TOOL_NAME,
      arguments: `{"candidates":[]} ${"x".repeat(1024 * 1024)}`,
    }], "toolUse"),
    (error: unknown) => error instanceof CandidateResponseParseError && error.kind === "tool-arguments-too-large",
  );
});

test("candidate response preserves optional feedback findings without changing candidates", () => {
  const parsed = parseCandidateAssistantResponse([{
    type: "toolCall",
    name: CANDIDATE_SUBMISSION_TOOL_NAME,
    arguments: {
      candidates: [{ candidate_id: "durable" }],
      feedback_findings: [{ classification: "local-configuration", component_id: "origin", observed: "remote unavailable" }],
    },
  }], "toolUse");
  assert.deepEqual(parsed.candidates, [{ candidate_id: "durable" }]);
  assert.deepEqual(parsed.feedback_findings, [{ classification: "local-configuration", component_id: "origin", observed: "remote unavailable" }]);

  const malformedOptional = parseCandidateAssistantResponse([{
    type: "toolCall",
    name: CANDIDATE_SUBMISSION_TOOL_NAME,
    arguments: { candidates: [{ candidate_id: "still-valid" }], feedback_findings: "not-an-array" },
  }], "toolUse");
  assert.deepEqual(malformedOptional.candidates, [{ candidate_id: "still-valid" }]);
});

test("tool-only responses classify every unusable expected argument shape", () => {
  const cases: Array<[unknown, string, string]> = [
    [{}, "tool-arguments-normalized-empty", "argumentShape=empty-object"],
    [undefined, "tool-arguments-unavailable", "argumentShape=missing"],
    [null, "tool-arguments-unavailable", "argumentShape=missing"],
    ["{private malformed argument", "tool-arguments-malformed-string", "argumentShape=malformed-string"],
    [42, "tool-arguments-unsupported", "argumentShape=unsupported"],
    [{ private: "missing candidates" }, "tool-envelope-missing-candidates", "argumentShape=object"],
    ['{"private":"missing candidates"}', "tool-envelope-missing-candidates", "argumentShape=string"],
  ];
  for (const [argumentsValue, kind, shape] of cases) {
    assert.throws(
      () => parseCandidateAssistantResponse([{
        type: "toolCall",
        name: CANDIDATE_SUBMISSION_TOOL_NAME,
        arguments: argumentsValue,
      }], "toolUse"),
      (error: unknown) => {
        assert.ok(error instanceof CandidateResponseParseError);
        assert.equal(error.kind, kind);
        assert.match(error.message, new RegExp(shape));
        assert.match(error.message, /stopReason=toolUse,blocks=1,textBlocks=0,toolCalls=1,expectedToolCalls=1/);
        assert.equal(error.message.includes("private"), false);
        assert.equal(error.message.includes("bytes=0"), false);
        return true;
      },
    );
  }
});

test("unexpected tool-only response is rejected without exposing its name or arguments", () => {
  const privateToolName = "private_exfiltration_tool";
  const privateArgument = "private argument payload credential provider response";
  assert.throws(
    () => parseCandidateAssistantResponse([{
      type: "toolCall",
      name: privateToolName,
      arguments: { secret: privateArgument },
    }], "toolUse"),
    (error: unknown) => {
      assert.ok(error instanceof CandidateResponseParseError);
      assert.equal(error.kind, "unexpected-tool");
      assert.match(error.message, /kind=unexpected-tool.*toolCalls=1,expectedToolCalls=0/);
      assert.equal(error.message.includes(privateToolName), false);
      assert.equal(error.message.includes(privateArgument), false);
      return true;
    },
  );
});

test("DeepSeek-style renamed or empty sole tool calls recover safely", () => {
  const renamed = parseCandidateAssistantResponse([{
    type: "toolCall",
    name: "SubmitSharedKnowledgeCandidates",
    arguments: { candidates: [{ candidate_id: "alias-ok" }] },
  }], "toolUse");
  assert.deepEqual(renamed, { candidates: [{ candidate_id: "alias-ok" }] });

  const nested = parseCandidateAssistantResponse([{
    type: "toolCall",
    name: "submit_candidates",
    arguments: { payload: { candidates: [], feedback_findings: [] } },
  }], "toolUse");
  assert.deepEqual(nested, { candidates: [], feedback_findings: [] });

  // Sole empty tool shell (common after Pi partial-json normalization) is a
  // structural tool failure, not an opaque unexpected-tool dead end.
  assert.throws(
    () => parseCandidateAssistantResponse([{
      type: "toolCall",
      name: "renamed_by_provider",
      arguments: {},
    }], "toolUse"),
    (error: unknown) => {
      assert.ok(error instanceof CandidateResponseParseError);
      assert.equal(error.kind, "tool-arguments-normalized-empty");
      assert.match(error.message, /soleToolRecovery=yes/);
      assert.equal(error.message.includes("renamed_by_provider"), false);
      return true;
    },
  );
});

test("assistant response falls back to bounded text when structured envelope is unusable", () => {
  const parsed = parseCandidateAssistantResponse([
    { type: "toolCall", name: "unrelated_tool", arguments: { secret: "ignored" } },
    { type: "text", text: "Result:\n```json\n{\"candidates\":[]}\n```" },
  ], "stop");
  assert.deepEqual(parsed, { candidates: [] });

  const expectedMalformedWithText = parseCandidateAssistantResponse([
    { type: "toolCall", name: CANDIDATE_SUBMISSION_TOOL_NAME, arguments: {} },
    { type: "text", text: '{"candidates":[{"candidate_id":"fallback"}]}' },
  ], "toolUse");
  assert.deepEqual(expectedMalformedWithText, { candidates: [{ candidate_id: "fallback" }] });
});

test("malformed text fallback diagnostics include safe shape and stop reason", () => {
  assert.throws(
    () => parseCandidateAssistantResponse([
      { type: "text", text: "```json\n{private malformed output\n```" },
      { type: "toolCall", name: CANDIDATE_SUBMISSION_TOOL_NAME, arguments: { private: "argument" } },
    ], "length"),
    (error: unknown) => {
      assert.ok(error instanceof CandidateResponseParseError);
      assert.equal(error.kind, "text-json-invalid");
      assert.match(error.message, /kind=text-json-invalid.*stopReason=length,blocks=2,textBlocks=1,toolCalls=1,expectedToolCalls=1/);
      assert.equal(error.message.includes("private malformed output"), false);
      assert.equal(error.message.includes("argument"), false);
      assert.ok(error.message.length < 450);
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

test("normalized empty tool failure integrates with durable bounded retry without downstream mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "tool-only-retry-"));
  const env = { ...process.env, SHARED_KNOWLEDGE_RUNTIME_DIR: join(root, "runtime") };
  const config = { maxPayloadBytes: 2048, retentionDays: 7, maxAttempts: 2, debounceMs: 0, maxBatchJobs: 1 };
  const queue = new KnowledgeJobQueue(root, config, env);
  const { job } = queue.enqueue(createCapturedPayload(
    root,
    "tool-only",
    "user decided this durable architecture must remain authority safe ".repeat(20),
    config,
  ));
  const parse = () => parseCandidateAssistantResponse([{
    type: "toolCall" as const,
    name: CANDIDATE_SUBMISSION_TOOL_NAME,
    arguments: {},
  }], "toolUse");

  assert.throws(parse, (error: unknown) => {
    const updated = queue.markRetry(job.id, error);
    assert.equal(updated.state, "retry-wait");
    assert.ok(updated.payload);
    assert.equal(updated.result, undefined);
    assert.match(updated.error ?? "", /kind=tool-arguments-normalized-empty/);
    assert.equal((updated.error ?? "").includes("bytes=0"), false);
    return error instanceof CandidateResponseParseError;
  });
  assert.throws(parse, (error: unknown) => {
    const updated = queue.markRetry(job.id, error);
    assert.equal(updated.state, "failed");
    assert.equal(updated.attempts, 2);
    assert.ok(updated.payload, "terminal tool failure must retain explicit recovery payload");
    assert.equal(updated.result, undefined);
    return error instanceof CandidateResponseParseError;
  });
  assert.equal(existsSync(join(root, "knowledge")), false, "parse failure must not materialize or absorb");
});

test("retry instruction is failure-kind and attempt aware", () => {
  assert.equal(extractionRetryInstruction(0, "kind=tool-arguments-normalized-empty"), "");
  assert.equal(extractionRetryInstruction(1, "Background extraction timed out"), "");

  const firstToolRetry = extractionRetryInstruction(1, "kind=tool-arguments-normalized-empty,stopReason=toolUse");
  assert.match(firstToolRetry, /Call the tool named submit_shared_knowledge_candidates exactly once/);
  assert.match(firstToolRetry, /candidates array/);
  assert.match(firstToolRetry, /Do not invent another tool name/);
  const laterToolRetry = extractionRetryInstruction(2, "kind=unexpected-tool,stopReason=toolUse");
  assert.match(laterToolRetry, /Return no prose/);
  assert.match(laterToolRetry, /\{"candidates":\[\]\}/);
  assert.match(laterToolRetry, /Never use any other tool name/);
  assert.notEqual(firstToolRetry, laterToolRetry);

  const historicalToolRetry = extractionRetryInstruction(
    1,
    "Model returned invalid candidate JSON (bytes=0,stopReason=toolUse,blocks=1,textBlocks=0,toolCalls=1)",
  );
  assert.match(historicalToolRetry, /submit_shared_knowledge_candidates/);

  const textRetry = extractionRetryInstruction(1, "Model returned invalid candidate submission (kind=text-json-invalid,bytes=10)");
  assert.match(textRetry, /Return exactly one JSON object/);
  assert.match(textRetry, /Do not use Markdown fences/);

  const textFallback = extractionRetryInstruction(1, "kind=unexpected-tool", { textJsonFallback: true });
  assert.match(textFallback, /Do not call tools/);
  assert.match(textFallback, /\{"candidates":\[\]\}/);
});
