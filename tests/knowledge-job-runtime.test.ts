import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  KnowledgeJobQueue,
  assertPrivateMode,
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
