# linkmi

A free link-in-bio page with hand-written WebGL shader backgrounds, careful typography and no accounts.

**Live:** [linkmi.ar](https://linkmi.ar) · **Example:** [linkmi.ar/sofiferro](https://linkmi.ar/sofiferro)

- 5 shaders (micelio, aurora, liquid chrome, mesh gradient, halftone) with custom colours and speed
- 4 type pairings, 4 button styles, adjustable corners
- One-click import from a public Linktree profile
- Editing without accounts: publishing gives you a secret edit link, and you can add passkeys

## Three ways to use it

1. **Hosted page** — open [`/editor`](https://linkmi.ar/editor), pick a name and publish. You get `linkmi.ar/yourname` plus a private edit link, shown once. Save the page to your keychain with a passkey too, so a lost link does not mean a lost page.
2. **Encoded link** — "link sin cuenta" in the editor puts the whole page inside the URL (`/p#…`). Nothing is stored anywhere.
3. **Your own deploy** — fork it and serve a single page from `linkmi.config.json`, with no database:

   [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fsofiaferro%2Flinkmi&env=LINKMI_MODE&envDescription=Set%20to%20%22single%22%20to%20serve%20only%20your%20own%20page&project-name=my-links)

   Set `LINKMI_MODE=single`, design your page in `/editor`, click "descargar config" and replace `linkmi.config.json` with the downloaded file.

## Stack

Next.js 16 (App Router, Cache Components) on Vercel · Upstash Redis for hosted pages · Vercel Blob for avatar uploads · SimpleWebAuthn for passkeys · raw WebGL, no 3D libraries.

## Edit access

A page has two kinds of credentials: its edit link (only a hash of the token is stored) and passkeys (only public keys are stored; user verification required). Either one opens a session in an httpOnly cookie, which is what the server trusts; no script can read it. Every request re-checks the credential behind the session, so revoking one takes effect at once, and writes that depend on a session re-check it inside the same Redis script. Passkeys outrank the link and an older passkey outranks a newer one; a credential never revokes, or ends the sessions of, one that outranks it. From the editor's "Acceso" section the owner can add passkeys (up to 10), remove the one they signed in with or newer ones, issue a new edit link (sessions opened with the old one end; passkey sessions stay), sign out the other browsers they outrank, and, from a passkey, take the page back in one step: every newer passkey goes and the link changes. Passkey sessions are bound to that exact passkey, so re-registering a removed credential id never revives them. Editors that kept the token in localStorage trade it once for a session and show it to be saved. There is no recovery by email: if every credential is lost, only whoever runs the deploy can issue a new link with `scripts/rotate-token.mjs`, which also drops every passkey. While a page has no passkey, whoever holds its link can lock the others out, so the editor nudges owners to add one.

The editor sends a strict, nonce-based Content Security Policy (`proxy.ts`), currently report-only with reports logged by `/api/csp-report`. Public pages are left out because a nonce would make them render per request instead of being cached.

## Running locally

```bash
npm install
vercel link && vercel env pull   # optional: only needed for hosted pages and uploads
npm run dev
```

Without Redis env vars the app still runs: the editor offers encoded links and config download instead of publishing.

## Environment

| Variable | Purpose |
| --- | --- |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Upstash Redis (hosted pages) |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob (avatar uploads, public store) |
| `ADMIN_SECRET` | Authorises cache purges from `scripts/takedown.mjs` |
| `LINKMI_MODE` | `single` serves `linkmi.config.json` at `/` |
| `LINKMI_REPORT_EMAIL` | Optional: shows a "reportar" link on public pages |

## Admin scripts

```bash
node --env-file=.env.local scripts/seed.mjs sofiferro        # seed a page, prints its edit link once
node --env-file=.env.local scripts/seed.mjs sofiferro --rotate  # overwrite and issue a new edit link
node --env-file=.env.local scripts/rotate-token.mjs <handle>  # admin recovery: new link, content kept, sessions and passkeys dropped
node --env-file=.env.local scripts/takedown.mjs <handle>      # remove a page and purge its cache
node --env-file=.env.local scripts/rename.mjs <old> <new>     # move a page to a new handle; old links follow it
```

## License

MIT
