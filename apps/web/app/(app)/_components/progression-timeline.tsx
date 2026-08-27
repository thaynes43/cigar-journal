import type { ProgressionEntryView } from "@cj/domain";
import { ui } from "@/lib/ui";
import { Chips } from "./chips";

// Read-only progression timeline, shared by the detail page and the edit form
// (existing entries are immutable — append-only per ADR-002).
export function ProgressionTimeline({ entries }: { entries: ProgressionEntryView[] }) {
  return (
    <ol className="flex flex-col gap-2">
      {entries.map((entry, index) => (
        <li key={index} className={`${ui.card} flex flex-col gap-2`}>
          <div className="flex items-center gap-2">
            {entry.stage ? <span className="font-medium">{entry.stage}</span> : null}
            {entry.approximatePosition != null ? (
              <span className={`text-xs ${ui.muted}`}>{Math.round(entry.approximatePosition * 100)}%</span>
            ) : null}
          </div>
          <Chips items={[...entry.descriptors, ...entry.specificDescriptors]} />
          {entry.verbatim ? <p className="text-sm">{entry.verbatim}</p> : null}
        </li>
      ))}
    </ol>
  );
}
