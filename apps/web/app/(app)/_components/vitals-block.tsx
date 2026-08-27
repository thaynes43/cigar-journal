import type { ReactNode } from "react";

// The facts grid: small-caps label over value, halfwheel-style. Null-tolerant —
// absent facts don't render, and an all-absent block renders nothing.
export interface VitalItem {
  label: string;
  value: ReactNode;
}

function present(value: ReactNode): boolean {
  return value !== null && value !== undefined && value !== "" && value !== false;
}

export function VitalsBlock({ items }: { items: VitalItem[] }) {
  const shown = items.filter((item) => present(item.value));
  if (shown.length === 0) return null;
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
      {shown.map((item) => (
        <div key={item.label} className="flex flex-col gap-1 border-t border-line pt-2">
          <dt className="label-caps">{item.label}</dt>
          <dd className="text-sm text-ink tabular-nums">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
