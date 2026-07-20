import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  defaultFeedbackProvenance,
  FEEDBACK_EVIDENCE_WINDOW_DAYS,
  FEEDBACK_PROVENANCE_ENV,
  SessionFeedbackStore,
  type CommandResult,
  type FeedbackFindingInput,
} from "../src/session-feedback-runtime.ts";

const repository = "example/shared-knowledge";

function finding(overrides: Partial<FeedbackFindingInput> = {}): FeedbackFindingInput {
  return {
    classification: "documentation-gap",
    component_kind: "extension",
    component_id: "shared-knowledge-lifecycle",
    user_goal: "preserve dirty working tree changes in a branch",
    expected: "the lifecycle should explain a safe path",
    observed: "the documented lifecycle does not explain how to preserve existing dirty changes",
    workaround: "create a branch manually before committing",
    normalized_goal: "preserve dirty changes in branch",
    normalized_gap: "lifecycle lacks dirty worktree guidance",
    normalized_outcome: "manual branch workaround",
    ...overrides,
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "session-feedback-"));
  let clock = new Date("2026-01-01T00:00:00.000Z");
  const calls: string[][] = [];
  const runner = (argv: string[]): CommandResult => {
    calls.push(argv);
    if (argv.slice(0, 3).join(" ") === "gh auth status") return { status: 0, stdout: "", stderr: "" };
    if (argv.slice(0, 3).join(" ") === "gh issue list") {
      return {
        status: 0,
        stdout: JSON.stringify([{ number: 12, title: "Existing safe issue", url: `https://github.com/${repository}/issues/12`, state: "OPEN" }]),
        stderr: "",
      };
    }
    if (argv.slice(0, 3).join(" ") === "gh issue create") {
      return { status: 0, stdout: `https://github.com/${repository}/issues/13\n`, stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "private command error" };
  };
  const workspace = join(root, "workspace");
  const store = new SessionFeedbackStore(workspace, {
    env: { ...process.env, SHARED_KNOWLEDGE_RUNTIME_DIR: join(root, "runtime") },
    provenance: defaultFeedbackProvenance(repository),
    now: () => clock,
    runner,
  });
  return {
    root,
    store,
    calls,
    advance(days: number) { clock = new Date(clock.getTime() + days * 86_400_000); },
  };
}

test("feedback persistence redacts paths, credentials, terminal controls, and raw session source", () => {
  const { store } = fixture();
  const source = "/home/alice/.pi/agent/sessions/private.jsonl";
  const accepted = store.ingest(source, [finding({
    observed: "\u001b]8;;https://bad.example\u0007Authorization: Bearer private-token token=ghp_ABCDEFGHIJKLMNOPQRST /home/alice/private/repo failed",
    evidence_summary: "[User]: copied transcript line should not persist",
  })]);
  assert.equal(accepted.findings.length, 1);
  const stored = accepted.findings[0]!;
  assert.notEqual(stored.sessionFingerprint, source);
  assert.equal(stored.observed.includes("ghp_"), false);
  assert.equal(stored.observed.includes("private-token"), false);
  assert.equal(stored.observed.includes("/home/alice"), false);
  assert.equal(stored.evidenceSummary?.includes("copied transcript"), false);
  const persisted = readFileSync(join(store.root, "state.json"), "utf8");
  assert.equal(persisted.includes(source), false);
  assert.equal(persisted.includes("ghp_"), false);
  assert.equal(persisted.includes("\u001b"), false);
});

test("two independent compatible sessions produce one ready candidate while repeats do not", () => {
  const { store, advance } = fixture();
  const first = store.ingest("session-a", [finding({
    component_version: "1.2.3",
    evidence_summary: "Open the queue after the documented lifecycle step.",
  })]);
  assert.equal(first.summary.tracking, 1);
  assert.equal(first.summary.readyForReview, 0);

  // A second compact segment from the same session is not independent evidence.
  store.ingest("session-a", [finding({ observed: "the documented lifecycle does not explain how to preserve existing dirty changes safely" })]);
  assert.equal(store.summary().readyForReview, 0);

  advance(1);
  store.ingest("session-b", [finding({ observed: "the documented lifecycle does not explain how to preserve existing dirty changes safely" })]);
  assert.equal(store.summary().readyForReview, 1);
  const [cluster] = store.queue();
  assert.equal(cluster?.state, "ready-for-review");
  assert.equal(cluster?.independentSessionCount, 2);
  const draft = store.cluster(cluster!.id)?.draft?.body ?? "";
  assert.match(draft, /## Summary\n/);
  assert.match(draft, /## Impact/);
  assert.match(draft, /Component version: 1\.2\.3/);
  assert.match(draft, /## Safe observation/);
  assert.match(draft, /observed in 2 independent local sessions within 90 days/);
});

test("observations older than the evidence window do not automatically corroborate", () => {
  const { store, advance } = fixture();
  store.ingest("old-session", [finding()]);
  advance(FEEDBACK_EVIDENCE_WINDOW_DAYS + 1);
  store.ingest("new-session", [finding()]);
  assert.equal(store.summary().readyForReview, 0);
  assert.equal(store.queue()[0]?.state, "tracking");
});

test("session reports group findings and expose only current automatic corroboration", () => {
  const { store, advance } = fixture();
  store.ingest("first-session", [
    finding(),
    finding({ classification: "local-configuration", observed: "a local setting blocks the workflow" }),
  ]);
  const firstReport = store.report("first-session");
  const upstream = firstReport.findingsForSession.find((entry) => entry.classification === "documentation-gap");
  const local = firstReport.findingsForSession.find((entry) => entry.classification === "local-configuration");
  assert.equal(upstream?.group, "upstream-candidate");
  assert.equal(upstream?.clusterState, "tracking");
  assert.equal(upstream?.independentSessionCount, 1);
  assert.equal(upstream?.additionalIndependentObservationsRequired, 1);
  assert.equal(local?.group, "local-or-environment");
  assert.equal(local?.clusterState, undefined);

  advance(FEEDBACK_EVIDENCE_WINDOW_DAYS + 1);
  store.ingest("later-session", [finding()]);
  const later = store.report("later-session").findingsForSession[0];
  assert.equal(later?.clusterState, "tracking");
  assert.equal(later?.independentSessionCount, 1, "expired evidence must not be presented as current corroboration");
  assert.equal(later?.additionalIndependentObservationsRequired, 1);
  assert.equal(store.queue()[0]?.independentSessionCount, 1);

  advance(1);
  store.ingest("final-session", [finding()]);
  const ready = store.queue()[0]!;
  assert.equal(ready.state, "ready-for-review");
  assert.equal(ready.independentSessionCount, 2);
  assert.match(store.cluster(ready.id)?.draft?.body ?? "", /observed in 2 independent local sessions within 90 days/);
});

test("hard gates prevent semantic-looking findings with a different goal or owner from merging", () => {
  const { store, advance } = fixture();
  store.ingest("session-a", [finding()]);
  advance(1);
  store.ingest("session-b", [finding({
    user_goal: "publish reviewed knowledge to a pull request",
    expected: "publisher should open a PR",
    observed: "publisher has a separate configuration problem",
    workaround: "configure the publisher policy",
    normalized_goal: "publish reviewed knowledge pull request",
    normalized_gap: "publisher configuration problem",
    normalized_outcome: "configure publisher policy",
  })]);
  advance(1);
  store.ingest("session-c", [finding({ component_id: "other-extension" })]);
  assert.equal(store.queue().length, 2, "unresolved owner is not an upstream queue cluster");
  assert.equal(store.summary().readyForReview, 0);
});

test("explicit local provenance maps an installed skill without model-selected repository authority", () => {
  const root = mkdtempSync(join(tmpdir(), "session-feedback-provenance-"));
  const env = {
    ...process.env,
    SHARED_KNOWLEDGE_RUNTIME_DIR: join(root, "runtime"),
    [FEEDBACK_PROVENANCE_ENV]: JSON.stringify([{
      component_kind: "skill",
      component_id: "ops-deliver",
      repository: "example/openspec-ops",
    }]),
  };
  let now = new Date("2026-01-01T00:00:00.000Z");
  const store = new SessionFeedbackStore(join(root, "workspace"), { env, now: () => now });
  const input = finding({
    component_kind: "skill",
    component_id: "ops-deliver",
    normalized_goal: "deliver lifecycle change",
    normalized_gap: "deliver instruction gap",
    normalized_outcome: "manual lifecycle workaround",
  });
  store.ingest("session-a", [input]);
  now = new Date("2026-01-02T00:00:00.000Z");
  store.ingest("session-b", [input]);
  assert.equal(store.queue()[0]?.repository, "example/openspec-ops");
  assert.equal(store.queue()[0]?.state, "ready-for-review");
});

test("manual promotion, splitting, suppression, and deletion remain local operations", () => {
  const { store, advance } = fixture();
  const first = store.ingest("session-a", [finding()]).findings[0]!;
  const tracking = store.queue()[0]!;
  assert.equal(store.manualPromote(tracking.id)?.state, "manually-promoted");
  assert.equal(store.summary().readyForReview, 1);
  assert.equal(store.dismissFinding(first.id), true);
  assert.equal(store.summary().readyForReview, 0, "dismissing the sole private evidence removes the manually promoted candidate");

  // A fresh cluster with two findings can be split without GitHub activity.
  store.ingest("session-c", [finding({ normalized_gap: "second independent issue gap", observed: "second independent issue gap" })]);
  advance(1);
  store.ingest("session-d", [finding({ normalized_gap: "second independent issue gap", observed: "second independent issue gap" })]);
  const ready = store.queue().find((cluster) => cluster.state === "ready-for-review");
  assert.ok(ready);
  const details = store.cluster(ready!.id)!;
  assert.ok(store.splitCluster(ready!.id, [details.findingIds[0]!]), "operator can split a cluster locally");
  store.suppress("documentation-gap", "shared-knowledge-lifecycle", repository);
  assert.equal(store.ingest("session-e", [finding()]).findings[0]?.disposition, "suppressed");
});

test("removing a finding and purging a session remove only private cluster contributions", () => {
  const { store, advance } = fixture();
  const first = store.ingest("session-a", [finding()]).findings[0]!;
  advance(1);
  store.ingest("session-b", [finding()]);
  assert.equal(store.summary().readyForReview, 1);
  assert.equal(store.removeFinding(first.id), true);
  assert.equal(store.summary().readyForReview, 0);
  assert.equal(store.purgeSession("session-b"), 1);
  assert.equal(store.report("session-a").findingsForSession.length, 0);
  assert.equal(store.report("session-b").findingsForSession.length, 0);
  assert.equal(store.queue().length, 0);
});

test("GitHub search and submit use only the trusted repository after explicit runtime calls", () => {
  const { store, calls, advance } = fixture();
  store.ingest("session-a", [finding()]);
  advance(1);
  store.ingest("session-b", [finding()]);
  const ready = store.queue().find((cluster) => cluster.state === "ready-for-review")!;
  assert.ok(ready);
  assert.equal(calls.length, 0, "ingestion must never contact GitHub");

  const search = store.searchDuplicates(ready.id);
  assert.equal(search.status, "ok");
  assert.equal(search.status === "ok" ? search.results[0]?.number : undefined, 12);
  const submitted = store.submit(ready.id);
  assert.equal(submitted?.url, `https://github.com/${repository}/issues/13`);
  assert.ok(calls.some((argv) => argv.join(" ").includes(`gh issue list --repo ${repository}`)));
  assert.ok(calls.some((argv) => argv.join(" ").includes(`gh issue create --repo ${repository}`)));
  assert.equal(calls.some((argv) => argv[0] === "git" || argv.includes("remote")), false);
  assert.equal(store.cluster(ready.id)?.state, "submitted");
});

test("existing issue linking validates the resolved repository and does not create a new issue", () => {
  const { store, calls, advance } = fixture();
  store.ingest("session-a", [finding()]);
  advance(1);
  store.ingest("session-b", [finding()]);
  const ready = store.queue().find((cluster) => cluster.state === "ready-for-review")!;
  assert.equal(store.linkExistingIssue(ready.id, "https://github.com/other/repo/issues/1"), undefined);
  assert.equal(store.linkExistingIssue(ready.id, `https://github.com/${repository}/issues/7`)?.number, 7);
  assert.equal(store.cluster(ready.id)?.state, "linked-existing");
  assert.equal(calls.length, 0);
});
