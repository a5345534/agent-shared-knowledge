import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  inboxCandidateIdentity,
  materializeInboxCandidate,
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

test("explicit review staging revalidates and deduplicates Inbox candidates", () => {
  const cwd = mkdtempSync(join(tmpdir(), "sk-review-stage-"));
  assert.equal(inboxCandidateIdentity(candidate), "safe-candidate");
  const first = materializeInboxCandidate(candidate, cwd);
  assert.equal(first.alreadyStaged, false);
  assert.ok(first.written);
  assert.match(readFileSync(join(cwd, first.written!), "utf8"), /candidate_id: safe-candidate/);
  const second = materializeInboxCandidate(candidate, cwd);
  assert.equal(second.alreadyStaged, true);
  assert.equal(second.written, undefined);
  assert.throws(
    () => materializeInboxCandidate({ ...candidate, body: "too short" }, cwd),
    /review candidate validation failed/,
  );
});

test("review staging fails closed when a nonmatching target file already occupies the deterministic path", () => {
  const cwd = mkdtempSync(join(tmpdir(), "sk-review-collision-"));
  const inbox = join(cwd, "knowledge", "inbox");
  mkdirSync(inbox, { recursive: true });
  const target = join(inbox, `${new Date().toISOString().slice(0, 10)}-safe-candidate.md`);
  writeFileSync(target, "not the candidate identity");
  assert.throws(() => materializeInboxCandidate(candidate, cwd), /EEXIST/);
  assert.equal(readFileSync(target, "utf8"), "not the candidate identity");
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

test("empty command candidate list is successful no-op and never spawns argv", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sk-command-empty-"));
  const marker = join(cwd, "spawned");
  const argv = [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`];
  const result = await materializeCandidates({ mode: "command", argv }, [], cwd);
  assert.deepEqual(result, { mode: "command", written: [] });
  assert.throws(() => readFileSync(marker));
});

test("invalid materializer configuration and command failure fail closed", async () => {
  assert.throws(
    () => parseMaterializerConfig({ SHARED_KNOWLEDGE_MATERIALIZER: "command" }),
    /binding is unavailable/,
  );
  assert.throws(
    () => parseMaterializerConfig({ SHARED_KNOWLEDGE_MATERIALIZER: "unsafe" }),
    /Invalid SHARED_KNOWLEDGE_MATERIALIZER/,
  );
  const cwd = mkdtempSync(join(tmpdir(), "sk-command-fail-"));
  await assert.rejects(
    materializeCandidates({ mode: "command", argv: [process.execPath, "-e", "process.exit(7)"] }, [candidate], cwd),
    /Materializer exited 7/,
  );
});
