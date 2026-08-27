"use client";

import type { ProgressionEntryInput } from "@cj/domain";
import { ui } from "@/lib/ui";
import { DescriptorsInput } from "./descriptors-input";

export interface ProgressionDraft {
  stage: string;
  position: string;
  descriptors: string[];
  verbatim: string;
}

export function emptyRow(): ProgressionDraft {
  return { stage: "", position: "", descriptors: [], verbatim: "" };
}

// Editable rows → domain progression entries, dropping rows the user left blank
// (zero rows is valid). Position is 0–1; the domain bounds-checks it.
export function toProgressionInput(rows: ProgressionDraft[]): ProgressionEntryInput[] {
  return rows
    .map((row) => ({
      stage: row.stage.trim() || null,
      approximatePosition: row.position.trim() === "" ? null : Number(row.position),
      descriptors: row.descriptors,
      verbatim: row.verbatim.trim() || null,
    }))
    .filter(
      (row) =>
        row.stage !== null ||
        row.approximatePosition !== null ||
        row.descriptors.length > 0 ||
        row.verbatim !== null,
    );
}

// The traditional stages people actually use; picking one sets the analytic
// position automatically. "Custom" reveals free-form stage + percent fields.
const STAGE_PRESETS = [
  { label: "Opening", position: "0.05" },
  { label: "First third", position: "0.15" },
  { label: "Second third", position: "0.5" },
  { label: "Final third", position: "0.85" },
  { label: "Finish", position: "0.95" },
] as const;

export function ProgressionEditor({
  value,
  onChange,
}: {
  value: ProgressionDraft[];
  onChange: (next: ProgressionDraft[]) => void;
}) {
  function update(index: number, patch: Partial<ProgressionDraft>) {
    onChange(value.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  return (
    <div className="flex flex-col gap-3">
      {value.map((row, index) => {
        const preset = STAGE_PRESETS.find((p) => p.label === row.stage && p.position === row.position);
        const isCustom = !preset && (row.stage !== "" || row.position !== "");
        return (
        <fieldset key={index} className={`${ui.card} flex flex-col gap-2`}>
          <legend className="sr-only">Stage {index + 1}</legend>
          <div className="flex gap-2">
            <label className={`${ui.label} flex-1`}>
              Stage
              <select
                value={preset ? preset.label : isCustom ? "custom" : ""}
                onChange={(e) => {
                  const next = STAGE_PRESETS.find((p) => p.label === e.target.value);
                  if (next) update(index, { stage: next.label, position: next.position });
                  else if (e.target.value === "custom") update(index, { stage: row.stage || "", position: "" });
                  else update(index, { stage: "", position: "" });
                }}
                className={ui.field}
              >
                <option value="">—</option>
                {STAGE_PRESETS.map((p) => (
                  <option key={p.label} value={p.label}>
                    {p.label}
                  </option>
                ))}
                <option value="custom">Custom</option>
              </select>
            </label>
            {isCustom ? (
              <>
                <label className={`${ui.label} flex-1`}>
                  Name
                  <input
                    value={row.stage}
                    onChange={(e) => update(index, { stage: e.target.value })}
                    className={ui.field}
                  />
                </label>
                <label className={`${ui.label} w-28`}>
                  Through (%)
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={5}
                    value={row.position === "" ? "" : String(Math.round(Number(row.position) * 100))}
                    onChange={(e) => {
                      const pct = e.target.value === "" ? "" : String(Math.min(100, Math.max(0, Number(e.target.value))) / 100);
                      update(index, { position: pct });
                    }}
                    className={ui.field}
                  />
                </label>
              </>
            ) : null}
          </div>
          <div className={ui.label}>
            Descriptors
            <DescriptorsInput value={row.descriptors} onChange={(d) => update(index, { descriptors: d })} />
          </div>
          <label className={ui.label}>
            Notes
            <textarea
              value={row.verbatim}
              onChange={(e) => update(index, { verbatim: e.target.value })}
              rows={2}
              className={ui.field}
            />
          </label>
          <button
            type="button"
            onClick={() => onChange(value.filter((_, i) => i !== index))}
            className={`${ui.button} self-start`}
          >
            Remove stage
          </button>
        </fieldset>
        );
      })}
      <button type="button" onClick={() => onChange([...value, emptyRow()])} className={`${ui.button} self-start`}>
        Add stage
      </button>
    </div>
  );
}
