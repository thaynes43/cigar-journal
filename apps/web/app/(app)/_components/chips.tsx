import { ui } from "@/lib/ui";

// Descriptor tags as chips. Two tiers per DESIGN-001: normalized descriptors
// as filled tobacco-toned chips, specific descriptors as quieter keyline
// chips. Renders nothing when empty so callers need no guard.
export function Chips({ items, specific = [] }: { items: string[]; specific?: string[] }) {
  if (items.length === 0 && specific.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <span key={item} className={ui.chip}>
          {item}
        </span>
      ))}
      {specific.map((item) => (
        <span key={item} className={`${ui.chipOutline} italic`}>
          {item}
        </span>
      ))}
    </div>
  );
}
