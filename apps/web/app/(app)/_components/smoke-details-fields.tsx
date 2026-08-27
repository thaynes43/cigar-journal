"use client";

import { ui } from "@/lib/ui";
import { DescriptorsInput } from "./descriptors-input";
import {
  STRENGTH_OPTIONS,
  BODY_OPTIONS,
  DRAW_OPTIONS,
  SMOKE_OUTPUT_OPTIONS,
  type SmokeDetailsDraft,
} from "./smoke-draft";

// Include the stored value as an option even if it is outside the preset list,
// so editing never silently drops an imported strength/body.
function options(base: string[], current: string): string[] {
  return current && !base.includes(current) ? [current, ...base] : base;
}

// The scalar detail controls shared by the record and edit forms. Cigar and
// progression are composed alongside by each form (their edit rules differ).
export function SmokeDetailsFields({
  value,
  onChange,
}: {
  value: SmokeDetailsDraft;
  onChange: (next: SmokeDetailsDraft) => void;
}) {
  function set<K extends keyof SmokeDetailsDraft>(key: K, next: SmokeDetailsDraft[K]) {
    onChange({ ...value, [key]: next });
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap gap-4">
        <label className={`${ui.label} w-56`}>
          Smoked at
          <input
            type="datetime-local"
            value={value.smokedAt}
            onChange={(e) => set("smokedAt", e.target.value)}
            className={ui.field}
          />
        </label>
        <label className={`${ui.label} w-28`}>
          Rating
          <input
            type="number"
            min={0}
            max={100}
            value={value.rating}
            onChange={(e) => set("rating", e.target.value)}
            className={ui.field}
          />
        </label>
        <label className={`${ui.label} w-28`}>
          Liked
          <select value={value.liked} onChange={(e) => set("liked", e.target.value as SmokeDetailsDraft["liked"])} className={ui.field}>
            <option value="">—</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </label>
      </div>

      <div className="flex flex-wrap gap-4 border-t border-line pt-5">
        <label className={`${ui.label} w-40`}>
          Strength
          <select value={value.strength} onChange={(e) => set("strength", e.target.value)} className={ui.field}>
            <option value="">—</option>
            {options(STRENGTH_OPTIONS, value.strength).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label className={`${ui.label} w-40`}>
          Body
          <select value={value.body} onChange={(e) => set("body", e.target.value)} className={ui.field}>
            <option value="">—</option>
            {options(BODY_OPTIONS, value.body).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex flex-wrap gap-4 border-t border-line pt-5">
        <label className={`${ui.label} w-40`}>
          Draw
          <select value={value.draw} onChange={(e) => set("draw", e.target.value as SmokeDetailsDraft["draw"])} className={ui.field}>
            <option value="">—</option>
            {DRAW_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label className={`${ui.label} w-40`}>
          Burn
          <select value={value.burn} onChange={(e) => set("burn", e.target.value as SmokeDetailsDraft["burn"])} className={ui.field}>
            <option value="">—</option>
            {DRAW_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label className={`${ui.label} w-40`}>
          Smoke output
          <select
            value={value.smokeOutput}
            onChange={(e) => set("smokeOutput", e.target.value as SmokeDetailsDraft["smokeOutput"])}
            className={ui.field}
          >
            <option value="">—</option>
            {SMOKE_OUTPUT_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className={ui.label}>
        Construction notes
        <textarea value={value.constructionNotes} onChange={(e) => set("constructionNotes", e.target.value)} rows={2} className={ui.field} />
      </label>

      <div className={`${ui.label} border-t border-line pt-5`}>
        Descriptors
        <DescriptorsInput value={value.overallDescriptors} onChange={(next) => set("overallDescriptors", next)} />
      </div>

      <label className={`${ui.label} border-t border-line pt-5`}>
        Impression
        <textarea value={value.impression} onChange={(e) => set("impression", e.target.value)} rows={2} className={ui.field} />
      </label>

      <label className={ui.label}>
        Title
        <input
          value={value.journalTitle}
          onChange={(e) => set("journalTitle", e.target.value)}
          className={`${ui.field} font-display text-base`}
        />
      </label>

      <label className={ui.label}>
        Narrative
        <textarea
          value={value.journalNarrative}
          onChange={(e) => set("journalNarrative", e.target.value)}
          rows={6}
          className={`${ui.field} font-serif text-base leading-relaxed`}
        />
      </label>
    </div>
  );
}
