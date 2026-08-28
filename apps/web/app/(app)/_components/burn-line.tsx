import type { ProgressionEntryView } from "@cj/domain";
import { Chips } from "./chips";

// The burn line (DESIGN-001 signature): a smoke's progression rendered along a
// stylized horizontal cigar — foot at the left, band and cap at the right.
// Detail page only: on journal cards an unlabeled bar read as a strength
// meter (issue #49), so cards carry the labeled StrengthMeter instead.
// Degradation is designed, honestly:
//   - every entry positioned  → markers at their 0–1 positions, ash-to-ember
//     gradient through the furthest entry, ember dot at the burn line;
//   - any position missing    → markers evenly spaced in order, labels only,
//     no gradient and no numeric axis implied;
//   - fewer than two entries  → no ribbon (the rail alone carries one entry;
//     an empty progression renders nothing).

export interface BurnLayout {
  mode: "positional" | "even" | "none";
  markers: number[]; // percent along the stick, foot → cap
  burn: number | null; // smoked extent in percent; positional mode only
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function burnLayout(positions: Array<number | null>): BurnLayout {
  if (positions.length < 2) return { mode: "none", markers: [], burn: null };
  if (positions.every((p) => p != null)) {
    const markers = positions.map((p) => clamp01(p!) * 100);
    return { mode: "positional", markers, burn: Math.max(...markers) };
  }
  const span = 92 - 8;
  const markers = positions.map((_, i) => 8 + (i * span) / (positions.length - 1));
  return { mode: "even", markers, burn: null };
}

function labelShift(percent: number): string {
  if (percent < 6) return "translateX(0)";
  if (percent > 94) return "translateX(-100%)";
  return "translateX(-50%)";
}

// Stage labels crowd unreadably when entries cluster (owner, 2026-08-28), so
// they lay out greedily across two staggered rows: a label takes the first row
// where it clears the row's last label by a width-scaled gap, and is culled
// when neither row fits. The rail below always carries every stage.
const MIN_LABEL_GAP = 12; // percentage points at a typical detail width

export function layoutStageLabels(
  entries: { stage: string | null }[],
  markers: number[],
): Array<{ index: number; row: 0 | 1 } | null> {
  const lastShown: [number, number] = [-Infinity, -Infinity];
  return entries.map((entry, index) => {
    if (!entry.stage) return null;
    const percent = markers[index]!;
    const gap = Math.max(MIN_LABEL_GAP, Math.min(entry.stage.length * 0.9, 22));
    for (const row of [0, 1] as const) {
      if (percent - lastShown[row] >= gap) {
        lastShown[row] = percent;
        return { index, row };
      }
    }
    return null;
  });
}

function Ribbon({ layout }: { layout: BurnLayout }) {
  return (
    <div aria-hidden className="relative h-7 w-full">
      {/* The stick: flat-cut foot at left, rounded cap at right, band stripe. */}
      <div className="absolute inset-y-2 right-0 left-0 overflow-hidden rounded-r-full bg-wrapper-leaf">
        <div className="absolute inset-y-0 left-[87%] w-[2.5%] bg-accent/70" />
        {layout.burn != null ? (
          <div
            className="absolute inset-y-0 left-0"
            style={{ width: `${layout.burn}%`, background: "linear-gradient(90deg, var(--ash), var(--ember))" }}
          />
        ) : null}
      </div>
      {layout.markers.map((percent, i) => (
        <span
          key={i}
          className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-muted bg-bg"
          style={{ left: `${percent}%` }}
        />
      ))}
      {layout.burn != null ? (
        <span
          className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ember"
          style={{ left: `${layout.burn}%`, boxShadow: "0 0 6px var(--ember)" }}
        />
      ) : null}
    </div>
  );
}

// Full burn line: the ribbon plus the entry rail. Read-only — progression is
// append-only (ADR-002); the edit form composes this beside its append editor.
export function BurnLine({ entries }: { entries: ProgressionEntryView[] }) {
  if (entries.length === 0) return null;
  const layout = burnLayout(entries.map((entry) => entry.approximatePosition));

  const labels = layoutStageLabels(entries, layout.markers).filter(
    (placed): placed is { index: number; row: 0 | 1 } => placed !== null,
  );
  const labelRows = labels.some((placed) => placed.row === 1) ? 2 : 1;

  return (
    <div className="flex flex-col gap-4">
      {layout.mode !== "none" ? (
        <div>
          <span className="label-caps">Burn line</span>
          <div aria-hidden className="mt-1">
            <Ribbon layout={layout} />
            <div className={`relative hidden sm:block ${labelRows === 2 ? "h-8" : "h-4"}`}>
              {labels.map(({ index, row }) => (
                <span
                  key={index}
                  className="absolute text-[0.625rem] font-semibold tracking-[0.14em] whitespace-nowrap text-muted uppercase"
                  style={{
                    top: row === 1 ? "1rem" : 0,
                    left: `${layout.markers[index]}%`,
                    transform: labelShift(layout.markers[index]!),
                  }}
                >
                  {entries[index]!.stage}
                </span>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      <ol className="flex flex-col gap-4 border-l border-line pl-4">
        {entries.map((entry, index) => (
          <li key={index} className="relative flex flex-col gap-1.5">
            <span className="absolute top-1.5 -left-[calc(1rem+3.5px)] size-1.5 rounded-full bg-accent" />
            {entry.stage || entry.approximatePosition != null ? (
              <div className="flex items-baseline gap-2">
                {entry.stage ? (
                  <span className="text-[0.6875rem] font-semibold tracking-[0.14em] text-ink uppercase">
                    {entry.stage}
                  </span>
                ) : null}
                {entry.approximatePosition != null ? (
                  <span className="text-xs text-muted tabular-nums">
                    {Math.round(entry.approximatePosition * 100)}%
                  </span>
                ) : null}
              </div>
            ) : null}
            <Chips items={entry.descriptors} specific={entry.specificDescriptors} />
            {entry.verbatim ? (
              <p className="font-serif text-[0.9375rem] leading-relaxed text-ink">{entry.verbatim}</p>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
