// Dead-simple login + consent gate for the spike. A single shared passcode
// (SPIKE_PASSCODE) stands in for the real identity system (ADR-004 will use
// Better Auth — deliberately NOT pulled into this throwaway). Not the product.

import type { Express, Request, Response } from "express";
import express from "express";
import type { SpikeConfig } from "../config.js";
import type { SpikeOAuthProvider } from "./provider.js";
import { authEvent } from "../logger.js";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1a1a1a}
  h1{font-size:1.3rem} .card{border:1px solid #ddd;border-radius:8px;padding:1.5rem}
  input[type=password]{width:100%;padding:.6rem;font-size:1rem;box-sizing:border-box}
  button{margin-top:1rem;padding:.6rem 1.2rem;font-size:1rem;cursor:pointer;border-radius:6px;border:1px solid #333;background:#333;color:#fff}
  .scopes{font-family:monospace;background:#f4f4f4;padding:.4rem .6rem;border-radius:4px}
  .err{color:#b00020} .muted{color:#666;font-size:.85rem}
</style></head><body><div class="card">${body}</div></body></html>`;
}

export function registerLoginRoutes(app: Express, provider: SpikeOAuthProvider, config: SpikeConfig): void {
  const urlencoded = express.urlencoded({ extended: false });

  // Step 1: passcode form.
  app.get("/login", (req: Request, res: Response) => {
    const txn = String(req.query.txn ?? "");
    const pending = provider.getPending(txn);
    if (!pending) {
      res.status(400).send(page("Invalid request", `<h1>Invalid or expired login link</h1><p class="muted">Start the connection again from your client.</p>`));
      return;
    }
    const err = req.query.err ? `<p class="err">Incorrect passcode.</p>` : "";
    res.send(
      page(
        "Cigar Journal Spike — sign in",
        `<h1>Cigar Journal — connectivity spike</h1>
         <p class="muted">Enter the shared passcode to authorize <b>${esc(pending.client.client_name ?? pending.client.client_id)}</b>.</p>
         ${err}
         <form method="post" action="/login/authenticate">
           <input type="hidden" name="txn" value="${esc(txn)}">
           <input type="password" name="passcode" placeholder="Passcode" autofocus autocomplete="off">
           <button type="submit">Continue</button>
         </form>`,
      ),
    );
  });

  // Step 2: verify passcode, show consent.
  app.post("/login/authenticate", urlencoded, (req: Request, res: Response) => {
    const txn = String(req.body.txn ?? "");
    const passcode = String(req.body.passcode ?? "");
    const pending = provider.getPending(txn);
    if (!pending) {
      res.status(400).send(page("Invalid request", `<h1>Invalid or expired login link</h1>`));
      return;
    }
    if (!config.passcode || passcode !== config.passcode) {
      authEvent("login_failed", { clientId: pending.client.client_id, txn });
      res.redirect(302, `/login?txn=${encodeURIComponent(txn)}&err=1`);
      return;
    }
    authEvent("login_ok", { clientId: pending.client.client_id, txn });
    const scopes = (pending.params.scopes ?? []).join(" ") || "(none requested)";
    const resource = pending.params.resource?.href ?? config.resourceUrl;
    res.send(
      page(
        "Authorize connection",
        `<h1>Authorize connection</h1>
         <p><b>${esc(pending.client.client_name ?? pending.client.client_id)}</b> is requesting access to your cigar journal.</p>
         <p class="muted">Scopes</p><p class="scopes">${esc(scopes)}</p>
         <p class="muted">Resource</p><p class="scopes">${esc(resource)}</p>
         <form method="post" action="/login/consent">
           <input type="hidden" name="txn" value="${esc(txn)}">
           <input type="hidden" name="passcode" value="${esc(passcode)}">
           <button type="submit">Approve</button>
         </form>`,
      ),
    );
  });

  // Step 3: consent → issue code, redirect to client.
  app.post("/login/consent", urlencoded, (req: Request, res: Response) => {
    const txn = String(req.body.txn ?? "");
    const passcode = String(req.body.passcode ?? "");
    const pending = provider.getPending(txn);
    if (!pending || !config.passcode || passcode !== config.passcode) {
      res.status(400).send(page("Invalid request", `<h1>Invalid or expired authorization</h1>`));
      return;
    }
    authEvent("consent_granted", { clientId: pending.client.client_id, txn });
    const redirect = provider.completeAuthorization(txn);
    res.redirect(302, redirect);
  });
}
