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
      {value.map((row, index) => (
        <fieldset key={index} className={`${ui.card} flex flex-col gap-2`}>
          <legend className="sr-only">Stage {index + 1}</legend>
          <div className="flex gap-2">
            <label className={`${ui.label} flex-1`}>
              Stage
              <input value={row.stage} onChange={(e) => update(index, { stage: e.target.value })} className={ui.field} />
            </label>
            <label className={`${ui.label} w-28`}>
              Position
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={row.position}
                onChange={(e) => update(index, { position: e.target.value })}
                className={ui.field}
              />
            </label>
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
      ))}
      <button type="button" onClick={() => onChange([...value, emptyRow()])} className={`${ui.button} self-start`}>
        Add stage
      </button>
    </div>
  );
}
