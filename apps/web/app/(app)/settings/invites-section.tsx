"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { InviteView } from "@cj/domain";
import { api } from "@/lib/trpc/react";
import { ui } from "@/lib/ui";
import { LocalDate } from "../_components/local-date";

// Invites (ADR-010, issue #46) — admin only; the section is not rendered at all
// for a `user`, and the server never sends the rows. The minted link is shown
// exactly once: only its hash is stored, so navigating away loses it and the
// admin mints a fresh one. Statuses are derived server-side.
const STATUS_LABEL: Record<InviteView["status"], string> = {
  open: "Open",
  redeemed: "Redeemed",
  expired: "Expired",
  revoked: "Revoked",
};

export function InvitesSection({ initial }: { initial: InviteView[] }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const list = api.invites.list.useQuery(undefined, { initialData: initial });
  const refresh = async () => {
    await list.refetch();
    router.refresh();
  };

  const create = api.invites.create.useMutation({
    onSuccess: ({ token }) => {
      setLink(`${window.location.origin}/invite/${token}`);
      setCopied(false);
      setEmail("");
      void refresh();
    },
  });
  const revoke = api.invites.revoke.useMutation({ onSuccess: () => void refresh() });

  const busy = create.isPending || revoke.isPending;

  return (
    <section className="flex flex-col gap-4">
      <h2 className="label-caps">Invites</h2>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate({ email });
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <label className={`${ui.label} min-w-0 flex-1`}>
          <span className={ui.legend}>Email</span>
          <input
            type="email"
            required
            autoComplete="off"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className={ui.field}
          />
        </label>
        <button type="submit" disabled={busy} className={ui.primary}>
          {create.isPending ? "Creating…" : "Create invite"}
        </button>
      </form>

      {link ? (
        <div className="flex flex-wrap items-center gap-2">
          <input readOnly value={link} className={`${ui.field} min-w-0 flex-1 font-mono text-xs`} />
          <button
            type="button"
            className={ui.button}
            onClick={() => {
              void navigator.clipboard?.writeText(link);
              setCopied(true);
            }}
          >
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      ) : null}

      {create.error || revoke.error ? (
        <p role="alert" className={ui.alert}>
          {create.error?.message ?? revoke.error?.message}
        </p>
      ) : null}

      {list.data.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm whitespace-nowrap">
            <thead>
              <tr className="border-b border-line text-left">
                {["Email", "Status", "Expires", ""].map((column, index) => (
                  <th key={column || index} className="label-caps px-3 py-2">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.data.map((invite) => (
                <tr key={invite.inviteId} className="border-b border-line/60">
                  <td className="px-3 py-2 text-ink">{invite.email}</td>
                  <td className="px-3 py-2 text-muted">{STATUS_LABEL[invite.status]}</td>
                  <td className="px-3 py-2 text-muted">
                    <LocalDate format="day" value={invite.expiresAt} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    {invite.status === "open" ? (
                      <button
                        type="button"
                        disabled={busy}
                        className={ui.danger}
                        onClick={() => revoke.mutate({ inviteId: invite.inviteId })}
                      >
                        Revoke
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
