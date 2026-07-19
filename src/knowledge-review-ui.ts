import {
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import type { ReviewItem, ReviewJobSummary } from "./knowledge-job-runtime.ts";

const MAX_DISPLAY_CHARS = 16_000;
const VIEWPORT_LINES = 18;

export type ReviewUiAction =
  | { action: "approve"; itemId: string; index: number }
  | { action: "reject"; itemId: string; index: number }
  | { action: "close" };

type ReviewTheme = {
  fg: (color: "accent" | "muted" | "dim" | "success" | "warning" | "error" | "text", text: string) => string;
  bold: (text: string) => string;
};

type RenderRequester = { requestRender(): void };

/** Removes untrusted terminal controls while preserving ordinary review text. */
export function sanitizeReviewText(value: unknown, maxChars = MAX_DISPLAY_CHARS): string {
  const source = typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : "(unavailable)";
  const normalized = source
    .replace(/\r\n?/g, "\n")
    .replace(/\x1B\][\s\S]*?(?:\x07|\x1B\\)/g, "") // OSC
    .replace(/\x1B[P^_][\s\S]*?\x1B\\/g, "") // DCS, PM, APC
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "") // CSI
    .replace(/\x1B[()][0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "");
  return normalized.length > maxChars
    ? `${normalized.slice(0, maxChars)}\n[review display truncated]`
    : normalized;
}

function candidateText(item: ReviewItem): string {
  const candidate = item.candidate;
  const evidence = Array.isArray(candidate.evidence)
    ? candidate.evidence
      .filter((value): value is string => typeof value === "string")
      .map((value) => `- ${sanitizeReviewText(value, 2_000)}`)
    : [];
  return [
    `Name: ${sanitizeReviewText(candidate.name, 1_000)}`,
    `Description: ${sanitizeReviewText(candidate.description, 2_000)}`,
    `Type: ${sanitizeReviewText(candidate.type, 160)}`,
    `Suggested scope: ${sanitizeReviewText(candidate.suggested_scope, 240)}`,
    "",
    "Reason:",
    sanitizeReviewText(candidate.reason, 4_000),
    "",
    "Evidence:",
    ...(evidence.length > 0 ? evidence : ["(none)" ]),
    "",
    "Candidate body:",
    sanitizeReviewText(candidate.body, MAX_DISPLAY_CHARS),
  ].join("\n");
}

function isKey(data: string, key: Parameters<typeof matchesKey>[1], printable?: string): boolean {
  return matchesKey(data, key) || (printable !== undefined && data.toLowerCase() === printable);
}

export class ReviewJobSelector implements Component {
  private selected = 0;

  constructor(
    private readonly jobs: ReviewJobSummary[],
    private readonly theme: ReviewTheme,
    private readonly tui: RenderRequester,
    private readonly done: (jobId: string | null) => void,
  ) {}

  handleInput(data: string): void {
    if (isKey(data, Key.up, "k") && this.selected > 0) this.selected -= 1;
    else if (isKey(data, Key.down, "j") && this.selected < this.jobs.length - 1) this.selected += 1;
    else if (matchesKey(data, Key.enter)) this.done(this.jobs[this.selected]?.id ?? null);
    else if (matchesKey(data, Key.escape)) this.done(null);
    else return;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(12, width);
    const lines = [
      truncateToWidth(this.theme.fg("accent", this.theme.bold("Shared Knowledge Review")), safeWidth),
      truncateToWidth(this.theme.fg("dim", "Select a review-ready job. Candidate content is loaded only after selection."), safeWidth),
      "",
    ];
    if (this.jobs.length === 0) {
      lines.push(truncateToWidth(this.theme.fg("muted", "No review-ready jobs in this workspace."), safeWidth));
    } else {
      for (const [index, job] of this.jobs.entries()) {
        const prefix = index === this.selected ? "> " : "  ";
        const availability = job.hasReviewContent
          ? `pending=${job.summary.pending} approved=${job.summary.approved} rejected=${job.summary.rejected} expired=${job.summary.expired}`
          : "review content unavailable";
        const modelHint = job.modelHint ? sanitizeReviewText(job.modelHint, 240) : "unknown";
        const updatedAt = sanitizeReviewText(job.updatedAt, 80);
        const label = `${prefix}${job.id} · ${availability} · model=${modelHint} · ${updatedAt}`;
        const truncated = sanitizeReviewText(truncateToWidth(label, safeWidth), safeWidth * 4);
        lines.push(index === this.selected ? this.theme.fg("accent", truncated) : truncated);
      }
    }
    lines.push("", truncateToWidth(this.theme.fg("dim", "↑↓ select · Enter open · Esc close"), safeWidth));
    return lines;
  }

  invalidate(): void {}
}

export class ReviewCandidateViewer implements Component {
  private index: number;
  private scrollOffset = 0;

  constructor(
    private readonly jobId: string,
    private readonly items: ReviewItem[],
    initialIndex: number,
    private readonly theme: ReviewTheme,
    private readonly tui: RenderRequester,
    private readonly done: (action: ReviewUiAction) => void,
  ) {
    this.index = Math.max(0, Math.min(initialIndex, Math.max(0, items.length - 1)));
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.done({ action: "close" });
      return;
    }
    const item = this.items[this.index];
    if (!item) {
      this.done({ action: "close" });
      return;
    }
    if (isKey(data, Key.left, "h")) {
      this.index = Math.max(0, this.index - 1);
      this.scrollOffset = 0;
    } else if (isKey(data, Key.right, "l")) {
      this.index = Math.min(this.items.length - 1, this.index + 1);
      this.scrollOffset = 0;
    } else if (matchesKey(data, Key.up) || data.toLowerCase() === "k") {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
    } else if (matchesKey(data, Key.down) || data.toLowerCase() === "j") {
      this.scrollOffset += 1;
    } else if (matchesKey(data, Key.pageUp)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - (VIEWPORT_LINES - 1));
    } else if (matchesKey(data, Key.pageDown)) {
      this.scrollOffset += VIEWPORT_LINES - 1;
    } else if (matchesKey(data, Key.home)) {
      this.scrollOffset = 0;
    } else if (matchesKey(data, Key.end)) {
      this.scrollOffset = Number.MAX_SAFE_INTEGER;
    } else if (isKey(data, "a", "a")) {
      this.done({ action: "approve", itemId: item.id, index: this.index });
      return;
    } else if (isKey(data, "r", "r")) {
      this.done({ action: "reject", itemId: item.id, index: this.index });
      return;
    } else if (isKey(data, "s", "s")) {
      if (this.items.length === 1) this.done({ action: "close" });
      else {
        this.index = (this.index + 1) % this.items.length;
        this.scrollOffset = 0;
      }
      return;
    } else {
      return;
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(16, width);
    const item = this.items[this.index];
    if (!item) return [truncateToWidth(this.theme.fg("warning", "Review candidate is unavailable."), safeWidth)];
    const contentWidth = Math.max(10, safeWidth - 2);
    const content = wrapTextWithAnsi(candidateText(item), contentWidth);
    const maxScroll = Math.max(0, content.length - VIEWPORT_LINES);
    this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
    const visible = content.slice(this.scrollOffset, this.scrollOffset + VIEWPORT_LINES);
    const lines = [
      truncateToWidth(this.theme.fg("accent", this.theme.bold(`Knowledge Review · ${this.index + 1} / ${this.items.length}`)), safeWidth),
      truncateToWidth(this.theme.fg("dim", `Job ${this.jobId} · private local view · scroll ${this.scrollOffset + 1}/${Math.max(1, content.length)}`), safeWidth),
      "",
      ...visible.map((line) => truncateToWidth(`  ${line}`, safeWidth)),
      "",
      truncateToWidth(this.theme.fg("dim", "↑↓ scroll · ←→ candidate · A approve to Inbox · R reject · S defer · Esc back"), safeWidth),
    ];
    return lines;
  }

  invalidate(): void {}
}
