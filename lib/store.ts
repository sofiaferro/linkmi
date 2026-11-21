import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Redis } from "@upstash/redis";
import { cacheLife, cacheTag } from "next/cache";
import { normalizeConfig, type PageConfig } from "./config";

const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;

/** Null when the deploy has no Redis (e.g. a self-hosted single-page fork). */
export const redis = url && token ? new Redis({ url, token }) : null;
export const storeEnabled = redis !== null;

const keys = {
  page: (h: string) => `page:${h}`,
  owner: (h: string) => `owner:${h}`,
  meta: (h: string) => `meta:${h}`,
  renamed: (h: string) => `renamed:${h}`,
};
/** Owner key of a page, for scripts in lib/auth.ts that must read it atomically. */
export const ownerKey = keys.owner;

export const pageTag = (handle: string) => `page:${handle}`;
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export const newToken = () => randomBytes(24).toString("base64url");

export async function getPage(handle: string): Promise<PageConfig | null> {
  "use cache";
  cacheTag(pageTag(handle));
  cacheLife("days");
  if (!redis) return null;
  const raw = await redis.get(keys.page(handle));
  return raw ? normalizeConfig(raw) : null;
}

export async function isTaken(handle: string): Promise<boolean> {
  if (!redis) return true;
  return (await redis.exists(keys.owner(handle))) === 1;
}

// Claiming also wipes edit access a previous page with this handle may have left behind
// (passkeys, the passkey user id, the session index), in the same step as the claim.
const CLAIM = `if not redis.call('SET', KEYS[1], ARGV[1], 'NX') then return 0 end
redis.call('DEL', KEYS[4], KEYS[5], KEYS[6])
redis.call('SET', KEYS[2], ARGV[2])
redis.call('SET', KEYS[3], ARGV[3])
return 1`;

/** Atomically claims a handle. Returns the plain edit token once, or null if already taken. */
export async function claimPage(handle: string, config: PageConfig): Promise<string | null> {
  if (!redis) return null;
  const editToken = newToken();
  const now = Date.now();
  const claimed = await redis.eval(
    CLAIM,
    [keys.owner(handle), keys.page(handle), keys.meta(handle), `passkeys:${handle}`, `pkuid:${handle}`, `sessions:${handle}`],
    [sha256(editToken), JSON.stringify(config), JSON.stringify({ createdAt: now, updatedAt: now })],
  );
  return claimed === 1 ? editToken : null;
}

/** Where scripts/rename.mjs moved a handle, so edit links and stored tokens keep working. */
export async function renamedTo(handle: string): Promise<string | null> {
  // String(): Upstash parses values as JSON, so a handle like "2024" would come back as a number.
  const moved = redis ? await redis.get(keys.renamed(handle)) : null;
  return moved === null ? null : String(moved);
}

export async function verifyOwner(handle: string, editToken: string): Promise<boolean> {
  if (!redis || !editToken) return false;
  const stored = await redis.get<string>(keys.owner(handle));
  if (!stored) return false;
  const a = Buffer.from(stored, "hex");
  const b = Buffer.from(sha256(editToken), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The hash of the page's current edit token. It changes on every new link, voiding link sessions. */
export async function ownerHash(handle: string): Promise<string | null> {
  return redis ? redis.get<string>(keys.owner(handle)) : null;
}
