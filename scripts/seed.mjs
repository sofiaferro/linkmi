// Seeds a page from lib/sofia.ts and prints its edit link once.
// Usage: node --env-file=.env.local scripts/seed.mjs [handle] [--rotate]
import { createHash, randomBytes } from "node:crypto";
import { SOFIA } from "../lib/sofia.ts";
import { redis, resetAccess } from "./redis.mjs";

const handle = process.argv.find((a, i) => i > 1 && !a.startsWith("--")) ?? "sofiferro";
const rotate = process.argv.includes("--rotate");
const editToken = randomBytes(24).toString("base64url");
const hash = createHash("sha256").update(editToken).digest("hex");

// A fresh claim or an overwrite: either way nothing from a previous owner may keep working.
const claimed = await resetAccess(handle, hash, rotate ? "any" : "nx");
if (!claimed) {
  console.log(`"${handle}" already exists. Use --rotate to overwrite it and issue a new edit token.`);
  process.exit(0);
}
const now = Date.now();
await redis.mset({ [`page:${handle}`]: SOFIA, [`meta:${handle}`]: { createdAt: now, updatedAt: now } });

const base = process.env.SITE_URL ?? "https://linkmi.ar";
console.log(`Seeded ${base}/${handle}`);
console.log(`Edit link (save it, it is shown only once):\n${base}/editor?h=${handle}#k=${editToken}`);
