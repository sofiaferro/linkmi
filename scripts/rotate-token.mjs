// Recovery by whoever runs the deploy: a new edit token for an existing page, keeping its content.
// Every session and passkey goes, since recovery means the previous credentials can no longer be trusted.
// Only run it for someone who proved they own the page some other way (e.g. a change on their linked profiles).
// Usage: node --env-file=.env.local scripts/rotate-token.mjs <handle>
import { createHash, randomBytes } from "node:crypto";
import { resetAccess } from "./redis.mjs";

const handle = process.argv[2];
if (!handle) {
  console.error("Usage: scripts/rotate-token.mjs <handle>");
  process.exit(1);
}
const editToken = randomBytes(24).toString("base64url");
const hash = createHash("sha256").update(editToken).digest("hex");

// Only for an existing page; content stays, every session and passkey goes in the same step.
if (!(await resetAccess(handle, hash, "xx"))) {
  console.error(`"${handle}" does not exist.`);
  process.exit(1);
}

const base = process.env.SITE_URL ?? "https://linkmi.ar";
console.log(`New edit token for "${handle}". The old edit link, every session and every passkey no longer work.`);
console.log(`Edit link (save it, it is shown only once):\n${base}/editor?h=${handle}#k=${editToken}`);
