import { ui } from "@/lib/ui";

// Descriptor tags as chips. Renders nothing when empty so callers need no guard.
export function Chips({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((item) => (
        <span key={item} className={ui.chip}>
          {item}
        </span>
      ))}
    </div>
  );
}
