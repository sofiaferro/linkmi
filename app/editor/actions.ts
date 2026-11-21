"use server";

import { headers } from "next/headers";
import { updateTag } from "next/cache";
import {
  currentSession,
  endOtherSessions,
  endSession,
  otherSessionCount,
  passkeyList,
  renewSession,
  rotateLink,
  savePageAs,
  takeBack,
  sessionError,
  sessionFor,
  startSession,
  type PasskeyInfo,
  type Session,
} from "@/lib/auth";
import { normalizeConfig, type PageConfig } from "@/lib/config";
import { handleError, normalizeHandle } from "@/lib/handles";
import { allow } from "@/lib/ratelimit";
import { claimPage, getPage, isTaken, pageTag, redis, renamedTo, sha256, verifyOwner } from "@/lib/store";

/** `signedOut` tells the editor this browser can no longer edit the page it shows. */
export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string; signedOut?: true };

const UNAVAILABLE = { ok: false, error: "publicar no está disponible en este deploy" } as const;
const BUSY = { ok: false, error: "demasiados intentos, probá en un rato" } as const;

/** What the editor shows about who can edit the page. */
export type Access = { handle: string; passkeys: PasskeyInfo[]; otherSessions: number };

async function accessFor(session: Session): Promise<Access> {
  const [passkeys, otherSessions] = await Promise.all([passkeyList(session), otherSessionCount(session)]);
  return { handle: session.handle, passkeys, otherSessions };
}

export async function checkHandle(raw: string): Promise<Result> {
  if (!redis) return UNAVAILABLE;
  const handle = normalizeHandle(raw);
  const error = handleError(handle);
  if (error) return { ok: false, error };
  return (await isTaken(handle)) ? { ok: false, error: "ese nombre ya está tomado" } : { ok: true };
}

export async function loadPage(raw: string): Promise<PageConfig | null> {
  const handle = normalizeHandle(raw);
  return handleError(handle) ? null : getPage(handle);
}

/** Publishing claims the handle, opens a session here and returns the edit link's token once. */
export async function publishPage(raw: string, input: unknown): Promise<Result<{ handle: string; token: string }>> {
  if (!redis) return UNAVAILABLE;
  const handle = normalizeHandle(raw);
  const error = handleError(handle);
  if (error) return { ok: false, error };
  if (!(await allow("publish", await headers()))) {
    return { ok: false, error: "demasiadas publicaciones, probá en un rato" };
  }
  const token = await claimPage(handle, normalizeConfig(input));
  if (!token) return { ok: false, error: "ese nombre ya está tomado" };
  updateTag(pageTag(handle));
  // The token is the only way back in, so a failed session must not swallow it.
  await startSession(handle, "publish", sha256(token)).catch(() => null);
  return { ok: true, handle, token };
}

/** The page an edit link opens, following scripts/rename.mjs moves (the token moves with the page). */
async function resolveLink(raw: string, token: unknown): Promise<string | null> {
  const named = normalizeHandle(raw);
  if (handleError(named) || typeof token !== "string") return null;
  if (await verifyOwner(named, token)) return named;
  const moved = await renamedTo(named);
  return moved && (await verifyOwner(moved, token)) ? moved : null;
}

type LinkResult<T> = Result<T> | { ok: false; error: string; invalid: true };
const INVALID_LINK = { ok: false, error: "el link de edición no es válido para esta página", invalid: true } as const;

/**
 * Trades an edit link (or the token an older editor kept in localStorage) for a session cookie.
 * `invalid` marks a token that will never work, so the editor can forget it.
 */
export async function openWithLink(raw: string, token: string): Promise<LinkResult<Access>> {
  if (!redis) return UNAVAILABLE;
  if (!(await allow("auth", await headers()))) return BUSY;
  const handle = await resolveLink(raw, token);
  if (!handle) return INVALID_LINK;
  return { ok: true, ...(await accessFor(await startSession(handle, "link", sha256(token)))) };
}

/** Checks an edit link without opening a session: for a token an older editor left for another page. */
export async function checkLink(raw: string, token: string): Promise<LinkResult<{ handle: string }>> {
  if (!redis) return UNAVAILABLE;
  if (!(await allow("auth", await headers()))) return BUSY;
  const handle = await resolveLink(raw, token);
  return handle ? { ok: true, handle } : INVALID_LINK;
}

/** The page this browser can edit, if any. Each visit renews the session. */
export async function resumeSession(): Promise<Access | null> {
  const session = await currentSession();
  if (!session) return null;
  await renewSession(session);
  return accessFor(session);
}

// Named differently from the old savePage(handle, token, config) so a tab left open across the deploy
// cannot reach this action with the old arguments.
export async function saveChanges(raw: string, input: unknown): Promise<Result> {
  if (!redis) return UNAVAILABLE;
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, error: "datos inválidos" };
  if (!(await allow("save", await headers()))) {
    return { ok: false, error: "demasiados cambios seguidos, probá en un rato" };
  }
  const session = await sessionFor(raw);
  if (typeof session === "string") return sessionError(session);
  if (!(await savePageAs(session, normalizeConfig(input)))) return sessionError("none");
  updateTag(pageTag(session.handle));
  return { ok: true };
}

/** Replaces the edit link. Sessions opened with the old link end; passkey sessions outrank it and stay. */
export async function newEditLink(raw: string): Promise<Result<{ token: string; access: Access }>> {
  if (!(await allow("auth", await headers()))) return BUSY;
  const session = await sessionFor(raw);
  if (typeof session === "string") return sessionError(session);
  const token = await rotateLink(session);
  if (!token) return sessionError("none");
  return { ok: true, token, access: await accessFor(session) };
}

/**
 * From a passkey session: removes every newer passkey, replaces the link and ends the sessions this
 * one outranks, in one step. For when someone else got in with a leaked link.
 */
export async function takeBackControl(raw: string): Promise<Result<{ token: string; access: Access }>> {
  if (!(await allow("auth", await headers()))) return BUSY;
  const session = await sessionFor(raw);
  if (typeof session === "string") return sessionError(session);
  const token = await takeBack(session);
  if (token === "not-passkey") return { ok: false, error: "para recuperar el control, entrá con tu passkey" };
  if (token === "signed-out") return sessionError("none");
  return { ok: true, token, access: await accessFor(session) };
}

/** Ends the other sessions this one outranks or equals. */
export async function signOutOthers(raw: string): Promise<Result<{ access: Access }>> {
  const session = await sessionFor(raw);
  if (typeof session === "string") return sessionError(session);
  await endOtherSessions(session);
  return { ok: true, access: await accessFor(session) };
}

/** Signs this browser out of `raw` only: a stale tab must not end the session of another page. */
export async function signOut(raw: string): Promise<void> {
  const session = await sessionFor(raw);
  if (typeof session !== "string") await endSession(session);
}
