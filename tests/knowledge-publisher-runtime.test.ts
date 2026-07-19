import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KnowledgePublisherQueue, KnowledgePublisherRuntime, type CommandResult } from "../src/knowledge-publisher-runtime.ts";
import { materializeInboxCandidate } from "../src/pi-lifecycle-materializer.ts";

const ok = (stdout = ""): CommandResult => ({ status: 0, stdout, stderr: "" });
const fail = (): CommandResult => ({ status: 1, stdout: "", stderr: "private raw failure" });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "knowledge-publisher-"));
  mkdirSync(join(root, ".git"));
  const runtime = join(root, "runtime");
  const inbox = join(root, "knowledge", "inbox");
  mkdirSync(inbox, { recursive: true });
  const path = "knowledge/inbox/approved.md";
  const body = "approved private candidate content";
  writeFileSync(join(root, path), body);
  const sha256 = createHash("sha256").update(body).digest("hex");
  return { root, runtime, path, body, sha256 };
}

function reviewJob(path: string): any {
  return {
    version: 1, id: "a".repeat(24), payloadHash: "hash", state: "done", createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z", attempts: 1,
    result: {
      candidateCount: 1, materializer: "review", written: [],
      reviewDecisions: { private: { state: "approved", inboxPath: path } },
      reviewSummary: { pending: 0, approved: 1, rejected: 0, expired: 0 },
    },
  };
}

function pipelineRunner(root: string, options: {
  checks?: any[]; mutateBeforeCleanup?: boolean; remoteUrl?: string; mergeable?: string;
  headSha?: string; mergeStatus?: number; ignored?: boolean; remoteHead?: string;
} = {}) {
  const calls: string[][] = [];
  let prBody = "";
  const runner = (argv: string[], cwd: string): CommandResult => {
    calls.push(argv);
    const command = argv.join(" ");
    if (command === "git remote get-url origin") return ok(`${options.remoteUrl ?? "git@github.com:owner/repo.git"}\n`);
    if (command.startsWith("gh auth status")) return ok();
    if (command === "git symbolic-ref --short refs/remotes/origin/HEAD") return ok("origin/main\n");
    if (command === "git rev-parse origin/main^{commit}") return ok("b".repeat(40));
    if (command.includes(" plan --format json")) return ok(JSON.stringify({ version: 1, actions: [{ candidatePath: "knowledge/inbox/approved.md", action: "retain_memory", destination: "knowledge/facts/workspace/approved.md", safeToApply: true }] }));
    if (command.includes(" apply ")) {
      rmSync(join(cwd, "knowledge", "inbox", "approved.md"), { force: true });
      mkdirSync(join(cwd, "knowledge", "facts", "workspace"), { recursive: true });
      writeFileSync(join(cwd, "knowledge", "facts", "workspace", "approved.md"), "canonical approved knowledge\n");
      return ok(JSON.stringify({ changedPaths: ["knowledge/inbox/approved.md", "knowledge/facts/workspace/approved.md"], skipped: [], followUps: [] }));
    }
    if (command === "git status --porcelain --untracked-files=all") return ok("?? knowledge/facts/workspace/approved.md\n");
    if (command.startsWith("git check-ignore")) return options.ignored ? ok() : fail();
    if (command === "git rev-parse HEAD^{commit}") return ok("c".repeat(40));
    if (command.startsWith("git ls-remote")) return ok(options.remoteHead ? `${options.remoteHead}\trefs/heads/shared-knowledge/publish-recovery\n` : "");
    if (command.startsWith("gh pr list")) return ok("[]");
    if (command.startsWith("gh pr create")) {
      prBody = argv[argv.indexOf("--body") + 1] ?? "";
      if (options.mutateBeforeCleanup) writeFileSync(join(root, "knowledge", "inbox", "approved.md"), "operator changed content");
      return ok("https://github.com/owner/repo/pull/7\n");
    }
    if (command.startsWith("gh pr view")) return ok(JSON.stringify({ state: "OPEN", mergeable: options.mergeable ?? "MERGEABLE", headRefOid: options.headSha ?? "c".repeat(40), baseRefName: "main", statusCheckRollup: options.checks ?? [], url: "https://github.com/owner/repo/pull/7", body: prBody }));
    if (command.startsWith("gh pr merge") && options.mergeStatus) return fail();
    return ok();
  };
  return { runner, calls };
}

test("publisher reconciles retained approvals once and redacts path/hash authority", () => {
  const { root, runtime, path } = fixture();
  const queue = new KnowledgePublisherQueue(root, { SHARED_KNOWLEDGE_RUNTIME_DIR: runtime });
  assert.equal(queue.reconcile([reviewJob(path), reviewJob(path)], "pr").length, 1);
  assert.equal(queue.list().length, 1);
  const output = JSON.stringify(queue.summaries());
  assert.equal(output.includes(path), false);
  assert.equal(output.includes("sha256"), false);
  assert.deepEqual(queue.reconcile([reviewJob(path)], "pr"), []);
  assert.deepEqual(queue.reconcile([reviewJob(path)], "off"), []);
});

test("PR mode isolates publication and cleans only unchanged approved Inbox input", async () => {
  const { root, runtime, path } = fixture();
  const queue = new KnowledgePublisherQueue(root, { SHARED_KNOWLEDGE_RUNTIME_DIR: runtime });
  queue.reconcile([reviewJob(path)], "pr");
  const fake = pipelineRunner(root);
  const job = await new KnowledgePublisherRuntime(queue, { absorberScript: "/pkg/absorb.py", lintScript: "/pkg/lint.py", runner: fake.runner }).processNext("pr");
  assert.equal(job?.state, "pr-open");
  assert.equal(job?.prNumber, 7);
  assert.equal(existsSync(join(root, path)), false);
  assert.ok(fake.calls.some((argv) => argv.join(" ") === "git push origin HEAD:refs/heads/shared-knowledge/publish-" + job?.id));
  const remoteMutations = fake.calls.filter((argv) => argv[0] === "gh" || (argv[0] === "git" && argv[1] === "push"));
  assert.equal(remoteMutations.some((argv) => argv.includes("--force") || argv.includes("--admin")), false);
});

test("validated phase recovers a completed remote push without reabsorbing", async () => {
  const { root, runtime, path } = fixture();
  const queue = new KnowledgePublisherQueue(root, { SHARED_KNOWLEDGE_RUNTIME_DIR: runtime });
  const pending = queue.reconcile([reviewJob(path)], "pr")[0]!;
  const commit = "c".repeat(40);
  queue.update(pending.id, { state: "validated", remote: "origin", base: "main", baseSha: "b".repeat(40), branch: `shared-knowledge/publish-${pending.id}`, commitSha: commit, localValidated: true });
  const fake = pipelineRunner(root, { remoteHead: commit });
  const job = await new KnowledgePublisherRuntime(queue, { absorberScript: "/pkg/absorb.py", lintScript: "/pkg/lint.py", runner: fake.runner }).processNext("pr");
  assert.equal(job?.state, "pr-open");
  assert.equal(fake.calls.some((argv) => argv.includes("/pkg/absorb.py")), false);
});

test("pushed phase recovers PR creation idempotently without reabsorbing", async () => {
  const { root, runtime, path } = fixture();
  const queue = new KnowledgePublisherQueue(root, { SHARED_KNOWLEDGE_RUNTIME_DIR: runtime });
  const pending = queue.reconcile([reviewJob(path)], "pr")[0]!;
  const commit = "c".repeat(40);
  queue.update(pending.id, { state: "pushed", remote: "origin", base: "main", baseSha: "b".repeat(40), branch: `shared-knowledge/publish-${pending.id}`, commitSha: commit, localValidated: true });
  const fake = pipelineRunner(root, { remoteHead: commit });
  const job = await new KnowledgePublisherRuntime(queue, { absorberScript: "/pkg/absorb.py", lintScript: "/pkg/lint.py", runner: fake.runner }).processNext("pr");
  assert.equal(job?.state, "pr-open");
  assert.equal(fake.calls.some((argv) => argv.includes("/pkg/absorb.py")), false);
  assert.equal(existsSync(join(root, path)), false);
});

test("hash race preserves local input after PR durability", async () => {
  const { root, runtime, path } = fixture();
  const queue = new KnowledgePublisherQueue(root, { SHARED_KNOWLEDGE_RUNTIME_DIR: runtime });
  queue.reconcile([reviewJob(path)], "pr");
  const fake = pipelineRunner(root, { mutateBeforeCleanup: true });
  const job = await new KnowledgePublisherRuntime(queue, { absorberScript: "/pkg/absorb.py", lintScript: "/pkg/lint.py", runner: fake.runner }).processNext("pr");
  assert.equal(job?.state, "pr-open");
  assert.equal(readFileSync(join(root, path), "utf8"), "operator changed content");
});

test("auto-merge accepts empty checks and uses normal squash without admin", async () => {
  const { root, runtime, path } = fixture();
  const queue = new KnowledgePublisherQueue(root, { SHARED_KNOWLEDGE_RUNTIME_DIR: runtime });
  queue.reconcile([reviewJob(path)], "auto-merge");
  const fake = pipelineRunner(root, { checks: [] });
  const job = await new KnowledgePublisherRuntime(queue, { absorberScript: "/pkg/absorb.py", lintScript: "/pkg/lint.py", runner: fake.runner }).processNext("auto-merge");
  assert.equal(job?.state, "merged");
  const merge = fake.calls.find((argv) => argv[0] === "gh" && argv[1] === "pr" && argv[2] === "merge");
  assert.deepEqual(merge, ["gh", "pr", "merge", "7", "--squash", "--delete-branch"]);
  assert.equal(merge?.includes("--admin"), false);
});

test("isolated publisher runs real safe-only absorption without touching unrelated dirt", async () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-publisher-real-git-"));
  const packageRoot = join(import.meta.dirname, "..");
  cpSync(join(packageRoot, "starter", "knowledge"), join(root, "knowledge"), { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "# Integration fixture\n");
  spawnSync("git", ["init", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "publisher@test.invalid"], { cwd: root });
  spawnSync("git", ["config", "user.name", "Publisher Test"], { cwd: root });
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-m", "base"], { cwd: root });
  const base = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  spawnSync("git", ["update-ref", "refs/remotes/origin/main", base], { cwd: root });
  spawnSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], { cwd: root });
  writeFileSync(join(root, "unrelated.txt"), "operator dirt");
  const staged = materializeInboxCandidate({
    candidate_id: "publisher-real-candidate", name: "Publisher real candidate",
    description: "A canonical fact produced in an isolated publisher test.", type: "reference",
    suggested_scope: "workspace", body: "The reviewed publisher must canonicalize approved content in an isolated worktree without touching unrelated dirt.",
    reason: "It verifies the real deterministic absorption path.", evidence: ["controlled integration fixture"],
  }, root);
  assert.ok(staged.written);
  const queue = new KnowledgePublisherQueue(root, { SHARED_KNOWLEDGE_RUNTIME_DIR: join(root, "runtime") });
  queue.reconcile([reviewJob(staged.written!)], "pr");
  const calls: string[][] = [];
  let observedStatus = "";
  const runner = (argv: string[], cwd: string, timeoutMs = 60_000): CommandResult => {
    calls.push(argv);
    const command = argv.join(" ");
    if (command === "git remote get-url origin") return ok("https://github.com/owner/repo.git\n");
    if (command.startsWith("gh auth status") || command === "git fetch --quiet origin" || command.startsWith("git push origin")) return ok();
    if (command.startsWith("git ls-remote")) return ok();
    if (command.startsWith("gh pr list")) return ok("[]");
    if (command.startsWith("gh pr create")) return ok("https://github.com/owner/repo/pull/9\n");
    const result = spawnSync(argv[0], argv.slice(1), { cwd, encoding: "utf8", timeout: timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    const output = { status: result.status ?? 1, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
    if (command === "git status --porcelain --untracked-files=all") observedStatus = output.stdout;
    return output;
  };
  const job = await new KnowledgePublisherRuntime(queue, {
    absorberScript: join(packageRoot, "scripts", "knowledge_absorb.py"),
    lintScript: join(packageRoot, "scripts", "knowledge_lint.py"), runner,
  }).processNext("pr");
  assert.equal(job?.state, "pr-open", `diagnostic=${job?.diagnostic} status=${JSON.stringify(observedStatus)} calls=${calls.map((argv) => argv.join(" ")).join(" | ")}`);
  assert.equal(readFileSync(join(root, "unrelated.txt"), "utf8"), "operator dirt");
  assert.equal(existsSync(join(root, staged.written!)), false);
  assert.equal(spawnSync("git", ["status", "--porcelain", "--", "unrelated.txt"], { cwd: root, encoding: "utf8" }).stdout.trim(), "?? unrelated.txt");
  assert.ok(calls.some((argv) => argv[0] === "git" && argv[1] === "worktree" && argv[2] === "add"));
});

test("auto-merge gate matrix fails closed without admin", async () => {
  const cases = [
    { name: "failed check", options: { checks: [{ conclusion: "FAILURE" }] }, diagnostic: "checks-failed" },
    { name: "neutral check", options: { checks: [{ conclusion: "NEUTRAL" }] }, diagnostic: "checks-failed" },
    { name: "cancelled check", options: { checks: [{ conclusion: "CANCELLED" }] }, diagnostic: "checks-failed" },
    { name: "conflict", options: { mergeable: "CONFLICTING" }, diagnostic: "merge-conflict" },
    { name: "unknown mergeability", options: { mergeable: "UNKNOWN" }, diagnostic: "checks-pending" },
    { name: "changed head", options: { headSha: "d".repeat(40) }, diagnostic: "stale-head" },
  ];
  for (const entry of cases) {
    const { root, runtime, path } = fixture();
    const queue = new KnowledgePublisherQueue(root, { SHARED_KNOWLEDGE_RUNTIME_DIR: runtime });
    queue.reconcile([reviewJob(path)], "auto-merge");
    const fake = pipelineRunner(root, entry.options);
    const job = await new KnowledgePublisherRuntime(queue, { absorberScript: "/pkg/absorb.py", lintScript: "/pkg/lint.py", runner: fake.runner }).processNext("auto-merge");
    assert.equal(job?.diagnostic, entry.diagnostic, entry.name);
    assert.equal(fake.calls.some((argv) => argv[2] === "merge"), false, entry.name);
  }
});

test("publisher blocks unsupported remote and ignored canonical output without cleanup", async () => {
  for (const options of [{ remoteUrl: "git@gitlab.com:owner/repo.git" }, { ignored: true }]) {
    const { root, runtime, path } = fixture();
    const queue = new KnowledgePublisherQueue(root, { SHARED_KNOWLEDGE_RUNTIME_DIR: runtime });
    queue.reconcile([reviewJob(path)], "pr");
    const fake = pipelineRunner(root, options);
    const job = await new KnowledgePublisherRuntime(queue, { absorberScript: "/pkg/absorb.py", lintScript: "/pkg/lint.py", runner: fake.runner }).processNext("pr");
    assert.equal(job?.state, "blocked");
    assert.equal(existsSync(join(root, path)), true);
  }
});

test("auto-merge blocks non-success checks", async () => {
  const { root, runtime, path } = fixture();
  const queue = new KnowledgePublisherQueue(root, { SHARED_KNOWLEDGE_RUNTIME_DIR: runtime });
  queue.reconcile([reviewJob(path)], "auto-merge");
  const fake = pipelineRunner(root, { checks: [{ status: "IN_PROGRESS" }] });
  const job = await new KnowledgePublisherRuntime(queue, { absorberScript: "/pkg/absorb.py", lintScript: "/pkg/lint.py", runner: fake.runner }).processNext("auto-merge");
  assert.equal(job?.state, "waiting");
  assert.equal(job?.diagnostic, "checks-pending");
  assert.equal(fake.calls.some((argv) => argv[2] === "merge"), false);
});
