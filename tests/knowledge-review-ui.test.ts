import assert from "node:assert/strict";
import test from "node:test";
import {
  ReviewCandidateViewer,
  ReviewJobSelector,
  sanitizeReviewText,
  type ReviewUiAction,
} from "../src/knowledge-review-ui.ts";
import type { ReviewItem, ReviewJobSummary } from "../src/knowledge-job-runtime.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};
const tui = { requestRender() {} };

const item = (id: string, body: string): ReviewItem => ({
  id,
  index: 0,
  candidate: {
    candidate_id: "private-candidate-identity",
    name: "Private candidate name",
    description: "A locally reviewed candidate.",
    type: "reference",
    suggested_scope: "workspace",
    reason: "It has evidence worth reviewing.",
    evidence: ["evidence line"],
    body,
  },
  decision: { state: "pending" },
});

test("review sanitizer removes terminal control sequences while preserving inert text", () => {
  const input = "before\x1b]8;;https://unsafe.invalid\x07link\x1b]8;;\x07\x1b[31mred\x1b[0m\x00after";
  const output = sanitizeReviewText(input);
  assert.equal(output.includes("\x1b"), false);
  assert.equal(output.includes("\x00"), false);
  assert.match(output, /beforelinkredafter/);
});

test("job selector renders safe metadata without candidate content", () => {
  const jobs: ReviewJobSummary[] = [{
    id: "a".repeat(24),
    state: "review-ready",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z\x1b[31m",
    candidateCount: 1,
    summary: { pending: 1, approved: 0, rejected: 0 },
    hasReviewContent: true,
  }];
  let selected: string | null | undefined;
  const selector = new ReviewJobSelector(jobs, theme, tui, (value) => { selected = value; });
  const rendered = selector.render(100).join("\n");
  assert.equal(rendered.includes("Private candidate"), false);
  assert.equal(rendered.includes("\x1b"), false);
  selector.handleInput("\r");
  assert.equal(selected, jobs[0].id);
});

test("candidate viewer navigates and renders markup as inert plaintext", () => {
  const first = item("item-one", "first body with [link](https://unsafe.invalid) and \x1b[31mcolor\x1b[0m");
  const second = item("item-two", "second body");
  second.index = 1;
  let action: ReviewUiAction | undefined;
  const viewer = new ReviewCandidateViewer("b".repeat(24), [first, second], 0, theme, tui, (value) => { action = value; });
  const firstRender = viewer.render(100).join("\n");
  assert.equal(firstRender.includes("\x1b"), false);
  assert.match(firstRender, /\[link\]\(https:\/\/unsafe.invalid\)/);
  assert.equal(firstRender.includes("private-candidate-identity"), false);

  viewer.handleInput("\x1b[C");
  assert.match(viewer.render(100).join("\n"), /second body/);
  viewer.handleInput("a");
  assert.deepEqual(action, { action: "approve", itemId: "item-two", index: 1 });
});
