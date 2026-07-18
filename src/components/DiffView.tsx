import { cn } from "@/utils/cn";

export interface DiffViewProps {
  /** Raw unified-diff text (e.g. the body of a ```diff fenced block, without the fence markers). */
  diff: string;
  className?: string;
}

type DiffLineTone = "add" | "remove" | "hunk" | "default";

/**
 * Reuses the exact success/danger/neutral tokens `Badge` uses for its tone
 * prop (see `ui.tsx` `TONE_CLASSES`) — no new design tokens invented here.
 */
const DIFF_LINE_TONE_CLASSES: Record<DiffLineTone, string> = {
  add: "bg-success-soft text-success",
  remove: "bg-danger-soft text-danger",
  hunk: "bg-card-3 text-ink-muted font-semibold",
  default: "text-ink",
};

/**
 * Classifies one unified-diff line by its leading marker. File-header lines
 * (`--- a/foo`, `+++ b/foo`) start with the same `-`/`+` characters as
 * remove/add content lines but are not diff content, so they're checked
 * before the single-character add/remove cases and fall back to the
 * default (unhighlighted) tone, same as hunk-adjacent context lines.
 */
function classifyDiffLine(line: string): DiffLineTone {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++") || line.startsWith("---")) return "default";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "remove";
  return "default";
}

/**
 * Dependency-free colored unified-diff renderer (Todo 2,
 * saml-fix-live-tryout-demo plan). Splits `diff` into lines and colors each
 * by its leading character — `+` green, `-` red, `@@` hunk headers
 * muted/bold, everything else default — with zero new npm dependency
 * (no diff2html / react-diff-viewer / monaco / shiki / prismjs / etc).
 */
export function DiffView({ diff, className }: DiffViewProps) {
  const lines = diff.split("\n");
  return (
    <div className={cn("overflow-auto whitespace-pre font-mono leading-relaxed", className)}>
      {lines.map((line, index) => (
        <div key={index} className={cn("px-1", DIFF_LINE_TONE_CLASSES[classifyDiffLine(line)])}>
          {line.length > 0 ? line : "\u00A0"}
        </div>
      ))}
    </div>
  );
}
