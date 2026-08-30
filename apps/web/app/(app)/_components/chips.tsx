import { ui } from "@/lib/ui";

// Descriptor tags as chips. Two tiers per DESIGN-001: normalized descriptors
// as filled tobacco-toned chips, specific descriptors as quieter keyline
// chips. Renders nothing when empty so callers need no guard.

// Normalized descriptors are stored kebab-cased (`dark-chocolate`), and 9% of
// the live vocabulary is multi-word, so a tenth of every chip row read as slugs
// (issue #49). This is a label transform only — hyphens to spaces, no case
// change, so the normalized tier matches the verbatim tier's voice and the
// archive's. `normalizeDescriptor` and every stored value, query path and MCP
// payload are untouched; `DescriptorsInput` is deliberately not transformed
// because it edits values, not labels.
function label(descriptor: string): string {
  return descriptor.replace(/-/g, " ");
}

export function Chips({ items, specific = [] }: { items: string[]; specific?: string[] }) {
  // Once hyphens read as spaces, a verbatim descriptor can land on the exact
  // words a normalized one now shows ({graham-cracker} + {"graham cracker"} —
  // 61 live progression rows carry both tiers and two hit this today). Two
  // chips reading the identical words is the collapse DESIGN-001's two tiers
  // exist to avoid, so the verbatim tier drops what the filled tier already
  // says. Stored values are untouched; this is the label pass only.
  const shown = new Set(items.map(label));
  const rest = specific.filter((item) => !shown.has(item));
  if (items.length === 0 && rest.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <span key={item} className={ui.chip}>
          {label(item)}
        </span>
      ))}
      {rest.map((item) => (
        <span key={item} className={`${ui.chipOutline} italic`}>
          {item}
        </span>
      ))}
    </div>
  );
}
