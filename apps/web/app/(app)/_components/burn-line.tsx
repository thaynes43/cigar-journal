import type { ProgressionEntryView } from "@cj/domain";
import { Chips } from "./chips";
import { HouseSeal } from "./house-seal";

// The burn line (DESIGN-001 signature): a smoke's progression rendered along a
// stylized cigar — foot at the left, cap at the right — drawn at forty pixels so
// the parts a cigar actually has are legible. At twelve it read as a progress bar
// with a stray block near the end.
//
// What is drawn, foot to cap:
//   - a CYLINDER, not a bar: wrapper leaf under a top highlight and a bottom
//     shadow, with faint diagonal veins, so a flat rectangle reads as rolled;
//   - ASH over the smoked length — grey, with flake cracks — instead of a
//     gradient;
//   - the EMBER as a glowing ring at the burn position, with a charred edge just
//     past it, so the eye lands on the exact place the save recorded;
//   - the BAND, brand orange with two espresso rules and the house seal, sitting
//     where a band sits (82–92%). It comes OFF once the burn reaches it, so a
//     nub with a long ash reads as a nub at a glance;
//   - the CAP: a half-round dome with two seam lines;
//   - MARKERS on the underside, labels beneath, so the annotations stop
//     competing with the object. There is no separate ember dot — the ember
//     band IS the burn position.
//
// It is drawn with divs and CSS, never canvas or a measured SVG: this component
// server-renders (the design tests assert on its static markup) and must paint
// on first byte, so nothing here may depend on the container's pixel width.
//
// Detail page only: on journal cards an unlabeled bar read as a strength meter
// (issue #49), so cards carry the labeled StrengthMeter instead.
//
// Degradation is designed, honestly — four modes, and none of them invents a
// position the save did not carry:
//   - every entry positioned  → markers at their 0–1 positions, ash and ember
//     through the furthest entry;
//   - some entries positioned → the positioned ones keep their real places and
//     the ash still runs to the furthest of them; an unpositioned entry gets no
//     marker and no label, because the alternative is either a fake axis or
//     throwing away the positions we do have. The rail below still lists every
//     entry;
//   - no entry positioned     → markers evenly spaced in order, labels only; the
//     stick is drawn whole and unlit (a foot cut, no ash, no ember) and the band
//     is on, because nothing was recorded about how far it burned;
//   - fewer than two entries  → no ribbon (the rail alone carries one entry;
//     an empty progression renders nothing).

export interface BurnLayout {
  mode: "positional" | "partial" | "even" | "none";
  // Percent along the stick, foot → cap, aligned index-for-index to the
  // entries. null is an entry with no position: it is drawn nowhere, never
  // interpolated between its neighbours.
  markers: Array<number | null>;
  burn: number | null; // smoked extent in percent; null in "even" and "none"
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function burnLayout(positions: Array<number | null>): BurnLayout {
  if (positions.length < 2) return { mode: "none", markers: [], burn: null };
  const markers = positions.map((p) => (p == null ? null : clamp01(p) * 100));
  const placed = markers.filter((p): p is number => p != null);
  if (placed.length === markers.length) {
    return { mode: "positional", markers, burn: Math.max(...placed) };
  }
  if (placed.length > 0) {
    return { mode: "partial", markers, burn: Math.max(...placed) };
  }
  const span = 92 - 8;
  const even = positions.map((_, i) => 8 + (i * span) / (positions.length - 1));
  return { mode: "even", markers: even, burn: null };
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
  markers: Array<number | null>,
): Array<{ index: number; row: 0 | 1 } | null> {
  const lastShown: [number, number] = [-Infinity, -Infinity];
  return entries.map((entry, index) => {
    if (!entry.stage) return null;
    const percent = markers[index];
    // No marker, no label: an unpositioned entry has no place on the ribbon.
    if (percent == null) return null;
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

// The stick's own geometry, in one place: the band's position and the burn at
// which it comes off are the SAME number, so the ash can never paint across it.
const BAND_START = 82; // percent along the stick
const BAND_WIDTH = 10;

// Wrapper veins under the ash, ash flake cracks, and the cylinder shading laid
// over everything inside the stick.
const VEINS = "repeating-linear-gradient(105deg, transparent 0 15%, rgb(0 0 0 / .11) 15% calc(15% + 1px))";
const CRACKS = "repeating-linear-gradient(92deg, transparent 0 33px, rgb(0 0 0 / .2) 33px 34px)";
const SHADE =
  "linear-gradient(to bottom, rgb(255 255 255 / .22) 0%, transparent 38%, transparent 62%, rgb(0 0 0 / .34) 100%)";

const STICK_HEIGHT = 40;
// Room for the markers, which hang half outside the stick's bottom edge. They
// are siblings of the stick, not children: the stick clips its own contents.
const RIBBON_HEIGHT = STICK_HEIGHT + 5;

// A cap seam: a full-height sliver whose right edge is an ellipse, echoing the
// dome. Two of them, just inside the cap.
function CapSeam({ right }: { right: number }) {
  return (
    <div
      className="absolute inset-y-0"
      style={{
        right,
        width: 16,
        borderRight: "1px solid rgb(0 0 0 / .28)",
        borderRadius: "0 50% 50% 0 / 0 50% 50% 0",
      }}
    />
  );
}

// The cigar band: the house seal on the brand orange, between two espresso
// rules. The seal is the favicon's mark minus its ground — the band IS the
// ground — and keeps its keyline and its engraved inline at this size.
//
// The band is a percentage of the stick and the seal is a fixed 32px, so below
// roughly a 320px stick the seal is wider than the band it sits on; the band
// clips rather than letting the mark spill onto the wrapper.
function Band() {
  return (
    <div
      className="absolute inset-y-0 flex items-center justify-center overflow-hidden"
      style={{ left: `${BAND_START}%`, width: `${BAND_WIDTH}%`, background: "var(--brand)" }}
    >
      <div
        className="absolute inset-x-0"
        style={{ top: 1.5, height: 1, background: "var(--brand-ink)", opacity: 0.8 }}
      />
      <div
        className="absolute inset-x-0"
        style={{ bottom: 1.5, height: 1, background: "var(--brand-ink)", opacity: 0.8 }}
      />
      <HouseSeal size={32} ground="none" frame inline />
    </div>
  );
}

function Ribbon({ layout }: { layout: BurnLayout }) {
  const burn = layout.burn;
  const lit = burn != null;

  return (
    <div aria-hidden className="relative w-full" style={{ height: RIBBON_HEIGHT }}>
      <div
        className="absolute inset-x-0 top-0 overflow-hidden bg-wrapper-leaf"
        style={{ height: STICK_HEIGHT, borderRadius: "0 20px 20px 0" }}
      >
        <div className="absolute inset-0" style={{ background: VEINS }} />
        <CapSeam right={6} />
        <CapSeam right={14} />
        {/* Unlit: the foot is a flat cut, never an ember. */}
        {lit ? null : (
          <div className="absolute inset-y-0 left-0" style={{ width: 2, background: "rgb(0 0 0 / .25)" }} />
        )}
        {burn == null || burn < BAND_START ? <Band /> : null}
        {lit ? (
          <>
            <div
              className="absolute inset-y-0 left-0"
              style={{ width: `calc(${burn}% - 3px)`, background: "var(--ash)", backgroundImage: CRACKS }}
            />
            <div
              className="absolute inset-y-0"
              style={{
                left: `calc(${burn}% - 3px)`,
                width: 5,
                background: "var(--ember)",
                boxShadow: "0 0 8px 2px var(--ember)",
              }}
            />
            <div
              className="absolute inset-y-0"
              style={{ left: `calc(${burn}% + 2px)`, width: 3, background: "rgb(26 18 12 / .78)" }}
            />
          </>
        ) : null}
        {/* Last child: the cylinder shading sits over ash, ember and band alike. */}
        <div className="absolute inset-0" style={{ background: SHADE }} />
      </div>
      {layout.markers.map((percent, i) =>
        percent == null ? null : (
          <span
            key={i}
            className="absolute rounded-full bg-bg"
            style={{
              top: STICK_HEIGHT,
              left: `${percent}%`,
              width: 9,
              height: 9,
              border: "1.25px solid var(--muted)",
              transform: "translate(-50%, -50%)",
            }}
          />
        ),
      )}
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
              {labels.map(({ index, row }) => {
                const percent = layout.markers[index]!;
                return (
                  <span
                    key={index}
                    className="absolute text-[0.625rem] font-semibold tracking-[0.14em] whitespace-nowrap text-muted uppercase"
                    style={{
                      top: row === 1 ? "1rem" : 0,
                      left: `${percent}%`,
                      transform: labelShift(percent),
                    }}
                  >
                    {entries[index]!.stage}
                  </span>
                );
              })}
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
