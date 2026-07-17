import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  KnowledgeJobQueue,
  assertPrivateMode,
  batchFollowerPatch,
  createReviewResult,
  createCapturedPayload,
  isMeaningfulConversation,
  normalizeConversation,
  parseQueueConfig,
} from "../src/knowledge-job-runtime.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "knowledge-jobs-"));
  return { root, env: { ...process.env, SHARED_KNOWLEDGE_RUNTIME_DIR: join(root, "runtime") } };
}

test("queue configuration applies bounded timeout and batching", () => {
  const config = parseQueueConfig({ SHARED_KNOWLEDGE_JOB_TIMEOUT_MS: "5000", SHARED_KNOWLEDGE_MAX_BATCH_JOBS: "2" });
  assert.equal(config.timeoutMs, 5000);
  assert.equal(config.maxBatchJobs, 2);
});

test("queue persists private idempotent jobs and redacts status", () => {
  const { root, env } = fixture();
  const queue = new KnowledgeJobQueue(root, { maxPayloadBytes: 2048, retentionDays: 7, maxAttempts: 3, debounceMs: 0, maxBatchJobs: 4 }, env);
  const payload = createCapturedPayload(root, "session-1", "user decided architecture must remain deterministic ".repeat(20), queue.config);
  const first = queue.enqueue(payload, "model-secret-free");
  const second = queue.enqueue(payload, "other");
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(queue.list().length, 1);
  assertPrivateMode(queue.root);
  assertPrivateMode(join(queue.jobsDir, `${first.job.id}.json`));
  queue.update(first.job.id, { result: { candidateCount: 1, materializer: "review", written: [], reviewCandidates: [{ body: "private candidate" }] } });
  assert.equal("payload" in queue.status()[0], false);
  assert.equal(queue.status()[0].sessionId, "session-1");
  assert.equal(JSON.stringify(queue.status()).includes("private candidate"), false);
  assert.equal(readFileSync(join(queue.jobsDir, `${first.job.id}.json`), "utf8").includes("Authorization"), false);
});

test("running jobs recover and retries become terminal", () => {
  const { root, env } = fixture();
  const queue = new KnowledgeJobQueue(root, { maxPayloadBytes: 2048, retentionDays: 7, maxAttempts: 2, debounceMs: 0, maxBatchJobs: 4 }, env);
  const { job } = queue.enqueue(createCapturedPayload(root, "s", "must preserve this durable decision ".repeat(20), queue.config));
  queue.update(job.id, { state: "running" });
  assert.equal(queue.recoverRunning(), 1);
  assert.equal(queue.read(job.id)?.state, "pending");
  queue.markRetry(job.id, "first");
  assert.equal(queue.read(job.id)?.state, "retry-wait");
  queue.markRetry(job.id, "second");
  assert.equal(queue.read(job.id)?.state, "failed");
});

test("failed jobs with retained payload can be explicitly retried", () => {
  const { root, env } = fixture();
  const queue = new KnowledgeJobQueue(root, { maxPayloadBytes: 2048, retentionDays: 7, maxAttempts: 1, debounceMs: 0, maxBatchJobs: 4 }, env);
  const { job } = queue.enqueue(createCapturedPayload(root, "s", "must preserve this durable decision ".repeat(20), queue.config));
  queue.markRetry(job.id, "invalid candidate JSON");

  const retried = queue.retryFailed(job.id);
  assert.equal(retried.state, "pending");
  assert.equal(retried.attempts, 0);
  assert.equal(retried.error, undefined);
  assert.ok(retried.payload);
  assert.equal(queue.nextReady()?.id, job.id);
  assert.throws(() => queue.retryFailed(job.id), /is not failed/);
});

test("failed jobs without retained payload cannot be retried", () => {
  const { root, env } = fixture();
  const queue = new KnowledgeJobQueue(root, { maxPayloadBytes: 2048, retentionDays: 0, maxAttempts: 1, debounceMs: 0, maxBatchJobs: 4 }, env);
  const { job } = queue.enqueue(createCapturedPayload(root, "s", "must preserve this durable decision ".repeat(20), queue.config));
  queue.markRetry(job.id, "invalid candidate JSON");
  queue.cleanup({ now: Date.now() + 1000 });

  assert.throws(() => queue.retryFailed(job.id), /no retained payload/);
});

test("ready jobs from one session are batched within limit", () => {
  const { root, env } = fixture();
  const config = { maxPayloadBytes: 2048, retentionDays: 7, maxAttempts: 3, debounceMs: 0, maxBatchJobs: 2 };
  const queue = new KnowledgeJobQueue(root, config, env);
  queue.enqueue(createCapturedPayload(root, "same", "first durable decision must remain ".repeat(20), config));
  queue.enqueue(createCapturedPayload(root, "same", "second durable decision must remain ".repeat(20), config));
  queue.enqueue(createCapturedPayload(root, "same", "third durable decision must remain ".repeat(20), config));
  assert.equal(queue.nextReadyBatch().length, 2);
});

test("payload normalization bounds binary and size", () => {
  const raw = `user must retain evidence ${"ordinary durable sentence ".repeat(500)} data:image/png;base64,${"B".repeat(1000)}`;
  const value = normalizeConversation(raw, 512);
  assert.equal(value.truncated, true);
  assert.ok(Buffer.byteLength(value.text) <= 520);
  assert.equal(value.text.includes("data:image/png"), false);
});

test("eligibility rejects noise and accepts durable conversation", () => {
  assert.equal(isMeaningfulConversation("PASS\n".repeat(10)), false);
  assert.equal(isMeaningfulConversation("user: We decided this architecture must never write canonical facts directly. ".repeat(4)), true);
});

test("cleanup supports dry run and removal", () => {
  const { root, env } = fixture();
  const queue = new KnowledgeJobQueue(root, { maxPayloadBytes: 2048, retentionDays: 0, maxAttempts: 2, debounceMs: 0, maxBatchJobs: 4 }, env);
  const { job } = queue.enqueue(createCapturedPayload(root, "s", "must preserve this durable decision ".repeat(20), queue.config));
  queue.update(job.id, { state: "done" });
  assert.deepEqual(queue.cleanup({ dryRun: true, now: Date.now() + 1000 }), [job.id]);
  assert.deepEqual(queue.cleanup({ now: Date.now() + 1000 }), [job.id]);
  assert.equal(queue.read(job.id)?.payload, undefined);
  assert.ok(queue.read(job.id)?.purgedAt);
  assert.equal(queue.enqueue(createCapturedPayload(root, "s", "must preserve this durable decision ".repeat(20), queue.config)).created, false);
});

const reviewCandidate = (candidateId = "review-candidate", body = "private review candidate body that must not reach status") => ({
  candidate_id: candidateId,
  name: "Review candidate",
  description: "A durable candidate for local review tests.",
  type: "reference",
  suggested_scope: "workspace",
  body,
  reason: "It exercises review-only state transitions.",
});

function reviewReady(queue: KnowledgeJobQueue, sessionId: string, candidate = reviewCandidate()) {
  const { job } = queue.enqueue(createCapturedPayload(queue.cwd, sessionId, "must preserve durable review decisions ".repeat(20), queue.config));
  queue.update(job.id, { state: "review-ready", payload: undefined, result: createReviewResult([candidate]) });
  return queue.read(job.id)!;
}

test("review decisions preserve legacy candidates, complete jobs, and redact status", async () => {
  const { root, env } = fixture();
  const queue = new KnowledgeJobQueue(root, { maxPayloadBytes: 2048, retentionDays: 7, maxAttempts: 2, debounceMs: 0, maxBatchJobs: 4 }, env);
  const job = reviewReady(queue, "review-session");
  const [item] = queue.pendingReviewItems(job.id);
  assert.ok(item, "legacy review candidates default to pending");

  const approved = await queue.approveReviewItem(
    job.id,
    item.id,
    () => "review-candidate",
    async () => ({ outcome: "staged", inboxPath: "knowledge/inbox/private-review-candidate.md" }),
  );
  assert.equal(approved.status, "approved");
  assert.equal(queue.read(job.id)?.state, "done");
  queue.update(job.id, { error: "private runtime error detail", modelHint: "safe-model\nprivate-control" });
  assert.deepEqual(queue.status()[0]?.result?.reviewSummary, { pending: 0, approved: 1, rejected: 0 });
  const publicStatus = JSON.stringify(queue.status());
  assert.equal(publicStatus.includes("private runtime error detail"), false);
  assert.equal(publicStatus.includes("safe-model\\n"), false);
  assert.equal(publicStatus.includes("private review candidate"), false);
  assert.equal(publicStatus.includes("private-review-candidate"), false);
  assert.equal(publicStatus.includes(item.id), false);
  assert.equal(queue.read(job.id)?.result?.reviewDecisions?.[item.id]?.inboxPath, "knowledge/inbox/private-review-candidate.md");
});

test("review rejection remains private and terminal detail is purged", async () => {
  const { root, env } = fixture();
  const queue = new KnowledgeJobQueue(root, { maxPayloadBytes: 2048, retentionDays: 0, maxAttempts: 2, debounceMs: 0, maxBatchJobs: 4 }, env);
  const job = reviewReady(queue, "review-reject", reviewCandidate("one"));
  const [item] = queue.pendingReviewItems(job.id);
  assert.ok(item);
  const rejected = await queue.rejectReviewItem(job.id, item.id);
  assert.equal(rejected.status, "rejected");
  assert.equal(queue.read(job.id)?.state, "done");
  assert.deepEqual(queue.cleanup({ now: Date.now() + 1000 }), [job.id]);
  const purged = queue.read(job.id)!;
  assert.equal(purged.result?.reviewCandidates, undefined);
  assert.equal(purged.result?.reviewDecisions, undefined);
  assert.deepEqual(purged.result?.reviewSummary, { pending: 0, approved: 0, rejected: 1 });
});

test("batched review followers complete without duplicated review candidates", () => {
  const { root, env } = fixture();
  const queue = new KnowledgeJobQueue(root, { maxPayloadBytes: 2048, retentionDays: 7, maxAttempts: 2, debounceMs: 0, maxBatchJobs: 4 }, env);
  const owner = reviewReady(queue, "batch-owner", reviewCandidate("batch-candidate"));
  const { job: follower } = queue.enqueue(createCapturedPayload(root, "batch-follower", "must preserve durable review decisions ".repeat(20), queue.config));
  const patch = batchFollowerPatch(queue.read(owner.id));
  assert.equal(patch.state, "done");
  assert.equal(patch.result?.reviewCandidates, undefined);
  queue.update(follower.id, patch);
  assert.equal(queue.read(follower.id)?.state, "done");
  assert.deepEqual(queue.reviewJobSummaries().map((job) => job.id), [owner.id]);
});

test("review locks recover a stale interrupted owner and serialize shared candidate identities", async () => {
  const { root, env } = fixture();
  const queue = new KnowledgeJobQueue(root, { maxPayloadBytes: 2048, retentionDays: 7, maxAttempts: 2, debounceMs: 0, maxBatchJobs: 4 }, env);
  const staleJob = reviewReady(queue, "stale");
  const [staleItem] = queue.pendingReviewItems(staleJob.id);
  assert.ok(staleItem);
  const staleScope = `item:${staleJob.id}:${staleItem.id}`;
  const staleName = `${createHash("sha256").update(staleScope).digest("hex").slice(0, 32)}.lock`;
  writeFileSync(join(queue.reviewLocksDir, staleName), JSON.stringify({ nonce: "dead", pid: 999999, createdAt: "1970-01-01T00:00:00.000Z" }));
  assert.equal((await queue.rejectReviewItem(staleJob.id, staleItem.id)).status, "rejected");

  const first = reviewReady(queue, "first", reviewCandidate("same-identity"));
  const second = reviewReady(queue, "second", reviewCandidate("same-identity"));
  const [firstItem] = queue.pendingReviewItems(first.id);
  const [secondItem] = queue.pendingReviewItems(second.id);
  assert.ok(firstItem && secondItem);
  let writes = 0;
  const staged = new Set<string>();
  const stage = async () => {
    if (staged.has("same-identity")) return { outcome: "already-staged" as const };
    staged.add("same-identity");
    writes += 1;
    return { outcome: "staged" as const, inboxPath: "knowledge/inbox/same-identity.md" };
  };
  const outcomes = await Promise.all([
    queue.approveReviewItem(first.id, firstItem.id, () => "same-identity", stage),
    queue.approveReviewItem(second.id, secondItem.id, () => "same-identity", stage),
  ]);
  assert.deepEqual(outcomes.map((outcome) => outcome.status), ["approved", "approved"]);
  assert.equal(writes, 1);
  assert.equal(queue.read(first.id)?.state, "done");
  assert.equal(queue.read(second.id)?.state, "done");
});
