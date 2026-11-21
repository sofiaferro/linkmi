// Moves a page to a new handle, keeping its content, edit token, passkeys and sessions.
// Usage: node --env-file=.env.local scripts/rename.mjs <old> <new>
import { redis } from "./redis.mjs";

const [from, to] = process.argv.slice(2);
if (!from || !to) {
  console.error("Usage: scripts/rename.mjs <old> <new>");
  process.exit(1);
}
// One script, so nobody can claim <old> halfway through and have their page moved along.
// Everything a request can see moves in this one step: keys, session records, the passkey owner and the
// redirect for old links. Leftovers under <new> (from an old takedown) are wiped first.
// KEYS: owner, page, meta, sessions, passkeys, pkuid (each <old>, <new>); ARGV: <old>, <new>.
const MOVE = `if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
for i = 2, #KEYS, 2 do redis.call('DEL', KEYS[i]) end
for i = 1, #KEYS, 2 do
  if redis.call('EXISTS', KEYS[i]) == 1 then redis.call('RENAME', KEYS[i], KEYS[i + 1]) end
end
for _, id in ipairs(redis.call('SMEMBERS', KEYS[8])) do
  local raw = redis.call('GET', 'sess:' .. id)
  if raw then
    local s = cjson.decode(raw)
    s.handle = ARGV[2]
    redis.call('SET', 'sess:' .. id, cjson.encode(s), 'XX', 'KEEPTTL')
  end
end
local uid = redis.call('GET', KEYS[12])
if uid then redis.call('SET', 'pkuser:' .. uid, ARGV[2]) end
redis.call('SET', 'renamed:' .. ARGV[1], ARGV[2])
return 1`;
const prefixes = ["owner", "page", "meta", "sessions", "passkeys", "pkuid"];
const moved = await redis.eval(MOVE, prefixes.flatMap((p) => [`${p}:${from}`, `${p}:${to}`]), [from, to]);
if (moved !== 1) {
  console.error(moved === 0 ? `"${to}" is already taken.` : `"${from}" not found.`);
  process.exit(1);
}

// Earlier names of this page are repointed too, so a chain of renames is still one hop.
// String(): Upstash parses values as JSON, so a handle like "2024" would come back as a number.
let cursor = "0";
do {
  const [next, found] = await redis.scan(cursor, { match: "renamed:*", count: 500 });
  cursor = String(next);
  for (const key of found) if (String(await redis.get(key)) === from) await redis.set(key, to);
} while (cursor !== "0");

const base = process.env.SITE_URL ?? "https://linkmi.ar";
const res = await fetch(`${base}/api/revalidate?h=${encodeURIComponent(from)}`, {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.ADMIN_SECRET ?? ""}` },
});
console.log(`Moved "${from}" to "${to}". Old cache purge: ${res.ok ? "ok" : `failed (${res.status})`}.`);
console.log(`Edit links keep working: links naming "${from}" now open "${to}".`);
