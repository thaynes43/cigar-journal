import Link from "next/link";
import { getServerCaller } from "@/lib/trpc/server";
import { formatSmokedAt } from "@/lib/format";
import { ui } from "@/lib/ui";
import { Chips } from "./_components/chips";

// The journal: the signed-in user's smokes, newest first.
export default async function JournalPage() {
  const caller = await getServerCaller();
  const { smokes } = await caller.smokes.list({ limit: 50 });

  if (smokes.length === 0) {
    return (
      <p>
        No smokes yet.{" "}
        <Link href="/smokes/new" className="underline">
          Record your first.
        </Link>
      </p>
    );
  }

  return (
    <ul className="flex flex-col divide-y divide-neutral-200 dark:divide-neutral-800">
      {smokes.map((smoke) => {
        const when = formatSmokedAt(smoke.smokedAt);
        return (
          <li key={smoke.smokeId} className="py-3">
            <Link href={`/smokes/${smoke.smokeId}`} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="font-medium">{smoke.cigar.canonicalName}</span>
                {smoke.liked ? (
                  <span className="text-red-600 dark:text-red-500" aria-label="Liked">
                    ♥
                  </span>
                ) : null}
                {smoke.rating != null ? <span className="ml-auto text-sm font-medium">{smoke.rating}</span> : null}
              </div>
              {when ? <span className={`text-sm ${ui.muted}`}>{when}</span> : null}
              <Chips items={smoke.descriptors.slice(0, 4)} />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
