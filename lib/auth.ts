import "server-only";
import { randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { normalizeHandle } from "./handles";
import type { PageConfig } from "./config";
import { newToken, ownerHash, ownerKey, redis, sha256 } from "./store";

/*
 * Edit access. A page has two kinds of credentials: its edit link (only its hash is stored, see store.ts)
 * and passkeys (only their public keys are stored). Either one opens a session, which lives in an
 * httpOnly cookie so no script on the page can read it. Sessions are what server actions trust.
 *
 * Every use re-checks the credential behind the session, so revoking it takes effect at once:
 *  - a session opened with the link records the page's owner hash; a new link changes it;
 *  - a session opened with a passkey records that passkey's nonce, so it dies with that exact
 *    passkey, even if a passkey with the same credential id is registered again later.
 *
 * Ranks: passkeys outrank the link, and an older passkey outranks a newer one. A credential never
 * revokes, or ends the sessions of, one that outranks it. So a new link only voids link sessions, link
 * sessions cannot remove passkeys, and a passkey can only remove itself or passkeys added after it.
 * A passkey can also take the page back in one step: every newer passkey goes and the link changes.
 * Writes that depend on a session (saving, adding or removing a passkey, a new link) re-check it inside
 * the same Redis script, so a revocation racing them cannot be undone.
 */

const prod = process.env.NODE_ENV === "production";
// __Host- pins a cookie to this exact host over HTTPS; localhost runs over http in dev, so plain names there.
const SESSION_COOKIE = prod ? "__Host-linkmi-session" : "linkmi-session";
// Renewed on every visit, so people who come back now and then never get locked out.
const SESSION_TTL = 60 * 60 * 24 * 365;
// Until the editor confirms the cookie stuck (resumeSession), so browsers that drop it leave no year-long debris.
const PENDING_TTL = 60 * 60 * 24;
// So nobody can flood a page with passkeys faster than an owner can remove them.
const MAX_PASSKEYS = 10;
const CHALLENGE_TTL = 5 * 60;

const keys = {
  session: (idHash: string) => `sess:${idHash}`,
  sessions: (h: string) => `sessions:${h}`,
  passkeys: (h: string) => `passkeys:${h}`,
  passkeyUser: (h: string) => `pkuid:${h}`,
  passkeyOwner: (userId: string) => `pkuser:${userId}`,
  challenge: (idHash: string) => `chal:${idHash}`,
};

const secret = () => randomBytes(32).toString("base64url");
const cookieOptions = (maxAge: number) => ({ httpOnly: true, secure: prod, sameSite: "strict" as const, path: "/", maxAge });

/** How the session was opened: "link", "publish" or "passkey:<credential id>". */
export type Session = { idHash: string; handle: string; via: string; passkeyId: string | null };
// `bind` is what the session lives on: the owner hash for link sessions, the passkey's nonce otherwise.
type SessionRecord = { handle: string; via: string; bind: string; createdAt: number };

const toSession = (idHash: string, r: SessionRecord): Session => ({
  idHash,
  handle: r.handle,
  via: r.via,
  passkeyId: r.via.startsWith("passkey:") ? r.via.slice("passkey:".length) : null,
});

/**
 * Opens a session bound to `bind`: the owner hash the caller verified a link against, or the nonce of
 * the passkey it verified (so a new link never ends a passkey session).
 */
export async function startSession(handle: string, via: string, bind: string): Promise<Session> {
  const jar = await cookies();
  // Opening another page in this browser replaces the previous session instead of orphaning it.
  const previous = jar.get(SESSION_COOKIE)?.value;
  if (previous) await dropSessions([sha256(previous)]);
  const id = secret();
  const idHash = sha256(id);
  const record: SessionRecord = { handle, via, bind, createdAt: Date.now() };
  await redis!.set(keys.session(idHash), record, { ex: PENDING_TTL });
  await redis!.sadd(keys.sessions(handle), idHash);
  jar.set(SESSION_COOKIE, id, cookieOptions(PENDING_TTL));
  return toSession(idHash, record);
}

/** The session behind this request, or null once the page or the credential behind it is gone. */
export async function currentSession(): Promise<Session | null> {
  if (!redis) return null;
  const id = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!id) return null;
  const idHash = sha256(id);
  const record = await redis.get<SessionRecord>(keys.session(idHash));
  if (!record) return null;
  const session = toSession(idHash, record);
  const alive = session.passkeyId
    ? (await getPasskey(record.handle, session.passkeyId))?.nonce === record.bind
    : (await ownerHash(record.handle)) === record.bind;
  if (!alive) {
    await dropSessions([idHash], record.handle);
    return null;
  }
  return session;
}

/** The session, only if it edits `handle`: a stale tab must never write to another page. */
export async function sessionFor(raw: string): Promise<Session | "none" | "other"> {
  const session = await currentSession();
  if (!session) return "none";
  return session.handle === normalizeHandle(raw) ? session : "other";
}

/** What the editor shows when sessionFor() fails; `signedOut` makes it drop the page it shows. */
export const sessionError = (reason: "none" | "other") =>
  reason === "none"
    ? ({ ok: false, signedOut: true, error: "tu sesión terminó: volvé a entrar con tu link de edición o tu passkey" } as const)
    : ({ ok: false, signedOut: true, error: "este navegador ahora edita otra página: recargá para ver cuál" } as const);

/** Extends the session by another full TTL, on the server and in the cookie. */
export async function renewSession(session: Session): Promise<void> {
  await redis!.expire(keys.session(session.idHash), SESSION_TTL);
  const jar = await cookies();
  const id = jar.get(SESSION_COOKIE)?.value;
  if (id) jar.set(SESSION_COOKIE, id, cookieOptions(SESSION_TTL));
}

export async function endSession(session: Session): Promise<void> {
  await dropSessions([session.idHash], session.handle);
  (await cookies()).set(SESSION_COOKIE, "", cookieOptions(0));
}

async function dropSessions(idHashes: string[], handle?: string) {
  if (!idHashes.length) return;
  await redis!.del(...idHashes.map(keys.session));
  if (handle) await redis!.srem(keys.sessions(handle), ...idHashes);
}

/** Other live sessions of the page that `session` may end; dead ones are dropped along the way. */
async function endableSessions(session: Session): Promise<string[]> {
  const idHashes = (await redis!.smembers(keys.sessions(session.handle))).filter((id) => id !== session.idHash);
  if (!idHashes.length) return [];
  const [records, passkeys, owner] = await Promise.all([
    redis!.mget<(SessionRecord | null)[]>(...idHashes.map(keys.session)),
    getPasskeys(session.handle),
    ownerHash(session.handle),
  ]);
  const others = idHashes.map((id, i) => ({ id, record: records[i], session: records[i] && toSession(id, records[i]) }));
  // Expired, or its credential is gone (same checks as currentSession).
  const dead = others.filter(
    ({ record, session: s }) =>
      !record ||
      !s ||
      (s.passkeyId ? !passkeys.some((p) => p.id === s.passkeyId && p.nonce === record.bind) : record.bind !== owner),
  );
  if (dead.length) await dropSessions(dead.map((d) => d.id), session.handle);
  return others
    .filter((o) => !dead.includes(o))
    .filter(({ session: s }) => !s!.passkeyId || mayRemovePasskey(session, passkeys, passkeys.find((p) => p.id === s!.passkeyId)!))
    .map((o) => o.id);
}

export async function otherSessionCount(session: Session): Promise<number> {
  return (await endableSessions(session)).length;
}

/** Ends the page's other sessions that `session` outranks or equals. */
export async function endOtherSessions(session: Session): Promise<void> {
  await dropSessions(await endableSessions(session), session.handle);
}

// JSON the scripts cannot decode (a planted, malformed passkey) reads as nil instead of failing the script.
const DECODE = `local function dec(v)
  if not v then return nil end
  local ok, r = pcall(cjson.decode, v)
  if ok and type(r) == 'table' then return r end
  return nil
end`;

/*
 * Redis scripts that act only while a session is still valid. KEYS: the session, the page's owner key
 * and its passkeys (then any extra keys); ARGV[1] the handle. Mirrors currentSession(); leaves `s` (the
 * session) and, for passkey sessions, `own` (its passkey) for the rest of the script.
 */
const SESSION_VALID = `${DECODE}
if redis.call('EXISTS', KEYS[2]) == 0 then return -1 end
local s = dec(redis.call('GET', KEYS[1]))
if not s or tostring(s.handle) ~= ARGV[1] then return -1 end
local own = nil
if string.sub(s.via, 1, 8) == 'passkey:' then
  own = dec(redis.call('HGET', KEYS[3], string.sub(s.via, 9)))
  if not own or own.nonce ~= s.bind or not tonumber(own.createdAt) then return -1 end
elseif redis.call('GET', KEYS[2]) ~= s.bind then return -1 end
`;
const sessionKeys = (session: Session) => [keys.session(session.idHash), ownerKey(session.handle), keys.passkeys(session.handle)];

// ARGV[2] the new owner hash. A link session that asks for the new link moves onto it.
const ROTATE_LINK = `${SESSION_VALID}
redis.call('SET', KEYS[2], ARGV[2])
if not own then
  s.bind = ARGV[2]
  redis.call('SET', KEYS[1], cjson.encode(s), 'XX', 'KEEPTTL')
end
return 1`;

/** Replaces the edit link and returns its token once; sessions opened with the old link die. */
export async function rotateLink(session: Session): Promise<string | null> {
  const token = newToken();
  const done = await redis!.eval(ROTATE_LINK, sessionKeys(session), [session.handle, sha256(token)]);
  return done === 1 ? token : null;
}

// Passkey sessions only. ARGV[2] the new owner hash. Every passkey newer than the caller's goes and
// the link changes, in one step: nothing the caller outranks can sign back in to add more.
const TAKE_BACK = `${SESSION_VALID}
if not own then return -3 end
local all = redis.call('HGETALL', KEYS[3])
for i = 1, #all, 2 do
  local p = dec(all[i + 1])
  -- Undecodable entries count as newest, so they can always be cleared.
  if not p or not tonumber(p.createdAt) or tonumber(p.createdAt) > tonumber(own.createdAt) then
    redis.call('HDEL', KEYS[3], all[i])
  end
end
redis.call('SET', KEYS[2], ARGV[2])
return 1`;

/** From a passkey session: drops everything it outranks and returns a new edit link's token once. */
export async function takeBack(session: Session): Promise<string | "signed-out" | "not-passkey"> {
  const token = newToken();
  const done = await redis!.eval(TAKE_BACK, sessionKeys(session), [session.handle, sha256(token)]);
  if (done === 1) {
    await endOtherSessions(session);
    return token;
  }
  return done === -3 ? "not-passkey" : "signed-out";
}

// KEYS[4] the page, KEYS[5] its meta; ARGV[2] the config, ARGV[3] now. A save racing a revocation or a
// takedown fails here instead of writing (and reviving a deleted page).
const SAVE_PAGE = `${SESSION_VALID}
local meta = dec(redis.call('GET', KEYS[5])) or { createdAt = tonumber(ARGV[3]) }
meta.updatedAt = tonumber(ARGV[3])
redis.call('SET', KEYS[4], ARGV[2])
redis.call('SET', KEYS[5], cjson.encode(meta))
return 1`;

export async function savePageAs(session: Session, config: PageConfig): Promise<boolean> {
  const done = await redis!.eval(
    SAVE_PAGE,
    [...sessionKeys(session), `page:${session.handle}`, `meta:${session.handle}`],
    [session.handle, JSON.stringify(config), String(Date.now())],
  );
  return done === 1;
}

/* Passkeys */

export type StoredPasskey = {
  id: string;
  nonce: string; // random per registration: sessions bind to it, not to the credential id
  publicKey: string; // base64url
  counter: number;
  transports?: string[];
  label: string;
  backedUp: boolean;
  createdAt: number;
  lastUsedAt: number | null;
};
export type PasskeyInfo = Pick<StoredPasskey, "id" | "label" | "backedUp" | "createdAt"> & {
  current: boolean; // the passkey that opened this session
  removable: boolean;
};

/** The WebAuthn user id for a page: random, stable, and mapped back to the handle for sign-in. */
export async function passkeyUserId(handle: string): Promise<string> {
  const fresh = randomBytes(16).toString("base64url");
  if (await redis!.set(keys.passkeyUser(handle), fresh, { nx: true })) {
    await redis!.set(keys.passkeyOwner(fresh), handle);
    return fresh;
  }
  return (await redis!.get<string>(keys.passkeyUser(handle)))!;
}

export async function handleForPasskeyUser(userId: string): Promise<string | null> {
  // String(): Upstash parses values as JSON, so a handle like "2024" would come back as a number.
  const handle = await redis!.get(keys.passkeyOwner(userId));
  return handle === null ? null : String(handle);
}

export async function getPasskeys(handle: string): Promise<StoredPasskey[]> {
  const all = await redis!.hgetall<Record<string, StoredPasskey>>(keys.passkeys(handle));
  return Object.values(all ?? {}).sort((a, b) => a.createdAt - b.createdAt);
}

export async function getPasskey(handle: string, id: string): Promise<StoredPasskey | null> {
  return redis!.hget<StoredPasskey>(keys.passkeys(handle), id);
}

/** Whether `session` may remove `target`: only from a passkey, and only itself or one added after it. */
export function mayRemovePasskey(session: Session, passkeys: StoredPasskey[], target: StoredPasskey): boolean {
  const own = passkeys.find((p) => p.id === session.passkeyId);
  return Boolean(own) && (target.id === own!.id || target.createdAt > own!.createdAt);
}

export async function passkeyList(session: Session): Promise<PasskeyInfo[]> {
  const passkeys = await getPasskeys(session.handle);
  return passkeys.map((p) => ({
    id: p.id,
    label: p.label,
    backedUp: p.backedUp,
    createdAt: p.createdAt,
    current: p.id === session.passkeyId,
    removable: mayRemovePasskey(session, passkeys, p),
  }));
}

// ARGV[2] the credential id, ARGV[3] the passkey, ARGV[4] the cap. HSETNX: an existing passkey is never overwritten.
const ADD_PASSKEY = `${SESSION_VALID}
if redis.call('HLEN', KEYS[3]) >= tonumber(ARGV[4]) then return -2 end
return redis.call('HSETNX', KEYS[3], ARGV[2], ARGV[3])`;

/** Adds a passkey if the session is still valid, the credential id is new and the page has room. */
export async function addPasskey(
  session: Session,
  passkey: StoredPasskey,
): Promise<"added" | "duplicate" | "full" | "signed-out"> {
  const done = await redis!.eval(ADD_PASSKEY, sessionKeys(session), [
    session.handle,
    passkey.id,
    JSON.stringify(passkey),
    String(MAX_PASSKEYS),
  ]);
  return done === 1 ? "added" : done === 0 ? "duplicate" : done === -2 ? "full" : "signed-out";
}

// Writes only if this exact passkey (same nonce) still exists: a sign-in racing its removal, or a
// re-registration under the same credential id, cannot bring it back.
const UPDATE_PASSKEY = `${DECODE}
local p = dec(redis.call('HGET', KEYS[1], ARGV[1]))
if not p or p.nonce ~= ARGV[3] then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
return 1`;

export async function updatePasskey(handle: string, passkey: StoredPasskey): Promise<boolean> {
  const done = await redis!.eval(
    UPDATE_PASSKEY,
    [keys.passkeys(handle)],
    [passkey.id, JSON.stringify(passkey), passkey.nonce],
  );
  return done === 1;
}

// ARGV[2] the passkey to remove. Same rule as mayRemovePasskey, checked where the write happens.
const REMOVE_PASSKEY = `${SESSION_VALID}
if not own then return -3 end
if redis.call('HEXISTS', KEYS[3], ARGV[2]) == 0 then return 1 end
local t = dec(redis.call('HGET', KEYS[3], ARGV[2]))
-- Undecodable entries count as newest, so they can always be removed.
if ARGV[2] ~= own.id and t and tonumber(t.createdAt) and tonumber(t.createdAt) <= tonumber(own.createdAt) then
  return -3
end
redis.call('HDEL', KEYS[3], ARGV[2])
return 1`;

/** Removes a passkey the session outranks; sessions it opened die on their next use. */
export async function deletePasskey(session: Session, id: string): Promise<"removed" | "outranked" | "signed-out"> {
  const done = await redis!.eval(REMOVE_PASSKEY, sessionKeys(session), [session.handle, id]);
  return done === 1 ? "removed" : done === -3 ? "outranked" : "signed-out";
}

/* WebAuthn ceremonies */

type Purpose = "register" | "login";
type Challenge = { challenge: string; purpose: Purpose; handle?: string };

/**
 * Keeps a ceremony's challenge server-side and returns a ticket for it, which the browser hands back
 * with the signed response. Tickets instead of one cookie, so a prefetch can never replace the
 * challenge of a ceremony already in progress.
 */
export async function saveChallenge(data: Challenge): Promise<string> {
  const ticket = secret();
  await redis!.set(keys.challenge(sha256(ticket)), data, { ex: CHALLENGE_TTL });
  return ticket;
}

/** Returns the challenge behind `ticket` once (it is deleted on read), if it was issued for `purpose`. */
export async function takeChallenge(purpose: Purpose, ticket: string): Promise<Challenge | null> {
  if (typeof ticket !== "string" || !ticket) return null;
  const data = await redis!.getdel<Challenge>(keys.challenge(sha256(ticket)));
  return data?.purpose === purpose ? data : null;
}

/** Relying party for WebAuthn: this exact host. Next rejects server actions whose Origin differs from it. */
export async function relyingParty(): Promise<{ rpID: string; origin: string }> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost";
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  const proto = h.get("x-forwarded-proto") ?? (local ? "http" : "https");
  return { rpID: host.replace(/:\d+$/, ""), origin: `${proto}://${host}` };
}

/** A short, human label for a passkey, from the browser that registered it. */
export async function deviceLabel(): Promise<string> {
  const ua = (await headers()).get("user-agent") ?? "";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh|Mac OS X/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  if (/Linux|CrOS/.test(ua)) return "Linux";
  return "dispositivo";
}
