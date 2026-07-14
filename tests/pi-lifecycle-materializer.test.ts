import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  materializeCandidates,
  parseMaterializerConfig,
  type Candidate,
} from "../src/pi-lifecycle-materializer.ts";

const candidate: Candidate = {
  candidate_id: "safe-candidate",
  name: "Safe candidate",
  description: "A durable candidate used by lifecycle materializer tests.",
  type: "reference",
  suggested_scope: "workspace",
  body: "This candidate body is sufficiently long for validation.",
  reason: "It verifies checkout-safe materialization behavior.",
};

test("review-only mode leaves the workspace untouched", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sk-review-"));
  const before = readdirSync(cwd);
  const result = await materializeCandidates(parseMaterializerConfig({}), [candidate], cwd);
  assert.deepEqual(result, { mode: "review", written: [] });
  assert.deepEqual(readdirSync(cwd), before);
});

test("explicit inbox mode writes a candidate", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sk-inbox-"));
  const result = await materializeCandidates({ mode: "inbox" }, [candidate], cwd);
  assert.equal(result.mode, "inbox");
  assert.equal(result.written.length, 1);
  assert.match(readFileSync(join(cwd, result.written[0]), "utf8"), /candidate_id: safe-candidate/);
});

test("command mode passes JSON on stdin and does not interpret shell syntax", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sk-command-"));
  const output = join(cwd, "payload.json");
  const marker = join(cwd, "must-not-exist");
  const code = "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>require('fs').writeFileSync(process.argv[1],JSON.stringify({payload:JSON.parse(s),arg:process.argv[2]})))";
  const argv = [process.execPath, "-e", code, output, `literal;touch ${marker}`];

  await materializeCandidates({ mode: "command", argv }, [candidate], cwd);

  const captured = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(captured.payload.cwd, cwd);
  assert.equal(captured.payload.candidates[0].candidate_id, "safe-candidate");
  assert.equal(captured.arg, `literal;touch ${marker}`);
  assert.throws(() => readFileSync(marker));
});

test("invalid materializer configuration fails closed", () => {
  assert.throws(
    () => parseMaterializerConfig({ SHARED_KNOWLEDGE_MATERIALIZER: "command" }),
    /requires SHARED_KNOWLEDGE_MATERIALIZER_COMMAND/,
  );
  assert.throws(
    () => parseMaterializerConfig({ SHARED_KNOWLEDGE_MATERIALIZER: "unsafe" }),
    /Unsupported materializer mode/,
  );
});
