// Removes a published page and frees its handle.
// Usage: node --env-file=.env.local scripts/takedown.mjs <handle>
import { deletePage } from "./redis.mjs";

const handle = process.argv[2];
if (!handle) {
  console.error("Usage: scripts/takedown.mjs <handle>");
  process.exit(1);
}
// Edit access goes with the page, in the same step (see lib/auth.ts).
const removed = await deletePage(handle);
if (!removed) {
  console.log(`"${handle}" not found.`);
  process.exit(0);
}

const base = process.env.SITE_URL ?? "https://linkmi.ar";
const res = await fetch(`${base}/api/revalidate?h=${encodeURIComponent(handle)}`, {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.ADMIN_SECRET ?? ""}` },
});
console.log(`Removed "${handle}". Cache purge: ${res.ok ? "ok" : `failed (${res.status}), it will expire within a day`}.`);
