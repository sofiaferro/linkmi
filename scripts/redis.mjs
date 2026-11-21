import { Redis } from "@upstash/redis";

const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
if (!url || !token) {
  console.error("Missing Redis env vars. Run with: node --env-file=.env.local scripts/<script>.mjs");
  process.exit(1);
}

export const redis = new Redis({ url, token });

// Access keys of a page besides owner/page/meta (see lib/auth.ts).
const accessKeys = (h) => [`passkeys:${h}`, `pkuid:${h}`, `sessions:${h}`];

/** Leftovers of a reset: they already fail every check (lib/auth.ts), this only keeps Redis tidy. */
async function sweep(sessions, passkeyUser) {
  const stale = [...sessions.map((s) => `sess:${s}`), ...(passkeyUser ? [`pkuser:${passkeyUser}`] : [])];
  if (stale.length) await redis.del(...stale);
}

// Sets the owner hash and drops every passkey in one step, so a session racing it cannot add one.
// Link sessions die with the old hash, passkey sessions with their passkeys. ARGV[2]: "nx", "xx" or "any".
const RESET = `if ARGV[2] == 'nx' and redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
if ARGV[2] == 'xx' and redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('DEL', KEYS[2], KEYS[3], KEYS[4])
return 1`;

/** Hands a page to a new edit token with no other credential left. Returns false if `mode` refused. */
export async function resetAccess(handle, ownerHash, mode) {
  const sessions = await redis.smembers(`sessions:${handle}`);
  const passkeyUser = await redis.get(`pkuid:${handle}`);
  const done = await redis.eval(RESET, [`owner:${handle}`, ...accessKeys(handle)], [ownerHash, mode]);
  if (done === 1) await sweep(sessions, passkeyUser);
  return done === 1;
}

/** Deletes a page and every way into it in one step. Returns how many keys existed. */
export async function deletePage(handle) {
  const sessions = await redis.smembers(`sessions:${handle}`);
  const passkeyUser = await redis.get(`pkuid:${handle}`);
  const keys = [`owner:${handle}`, `page:${handle}`, `meta:${handle}`, ...accessKeys(handle)];
  const removed = await redis.eval("return redis.call('DEL', unpack(KEYS))", keys, []);
  await sweep(sessions, passkeyUser);
  return removed;
}
