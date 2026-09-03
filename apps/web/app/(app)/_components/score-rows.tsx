import type { SurfaceScores } from "@cj/domain";
import { CATALOG_SCORE_STRINGS } from "./catalog-registry";

// The two labelled aggregates as DESIGN-006 renders them, in ONE component
// because the leaf detail page and the drill header render the identical pair and
// two spellings of the same sentence is exactly what a strings table exists to
// prevent.
//
// THE LABEL AND THE COUNT ARE NOT DECORATION. ADR-013 §1 forbids any surface from
// presenting a number without the population it came from and the size of that
// population, so there is no prop here that yields a bare score: a row renders
// `Critics 91 · 12 reviews` or it does not render. An absent population renders
// NOTHING — not a zero, not a dash — because "critics scored it zero" and "no
// critic has scored it" are different claims (DESIGN-006 rule 1).
//
// ONE TEXT NODE PER ROW (DESIGN-006 §Accessibility). The three spans carry
// styling, not structure: the row reads as one continuous string to a screen
// reader, the separator is a character rather than a border, and no icon carries
// meaning. The spaces are written into the strings, not left to flex `gap`, so
// the accessible text is right even where the CSS is not.

function ScoreRow({ label, score, count }: { label: string; score: number; count: string }) {
  return (
    <p className="text-sm">
      <span className="label-caps text-muted">{label}</span>
      <span className="tabular-nums text-ink">{` ${score}`}</span>
      <span className="text-muted">{` · ${count}`}</span>
    </p>
  );
}

export function ScoreRows({
  scores,
  // The blend to name when the figures are the blend's rather than this leaf's
  // (DESIGN-006 rule 2: the scope is named whenever it is wider than the
  // surface). Omitted by the drill header, where the header IS the scope.
  fallbackBlendName = null,
}: {
  scores: SurfaceScores;
  fallbackBlendName?: string | null;
}) {
  const { critics, journal } = scores;
  if (critics == null && journal == null) return null;

  // The caption fires when EITHER figure came from the blend. The two populations
  // resolve their scope independently — a leaf can have its own smokes but no
  // reviews of its own — so a mixed pair is legitimate, and the honest thing to
  // do with one is to say a wider scope is in play rather than to say nothing.
  const widened =
    fallbackBlendName != null && (critics?.scope === "blend" || journal?.scope === "blend");

  return (
    <div className="flex flex-col gap-0.5">
      {critics ? (
        <ScoreRow
          label={CATALOG_SCORE_STRINGS.critics}
          score={critics.score}
          count={CATALOG_SCORE_STRINGS.reviews(critics.count)}
        />
      ) : null}
      {journal ? (
        <ScoreRow
          label={CATALOG_SCORE_STRINGS.journal}
          score={journal.score}
          count={CATALOG_SCORE_STRINGS.journals(journal.count)}
        />
      ) : null}
      {widened ? (
        <p className="label-caps text-muted">
          {CATALOG_SCORE_STRINGS.across(fallbackBlendName)}
        </p>
      ) : null}
    </div>
  );
}
