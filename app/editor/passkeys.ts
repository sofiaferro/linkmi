"use server";

import { randomBytes } from "node:crypto";
import { headers } from "next/headers";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import {
  addPasskey,
  deletePasskey,
  deviceLabel,
  getPasskey,
  getPasskeys,
  handleForPasskeyUser,
  passkeyList,
  passkeyUserId,
  relyingParty,
  saveChallenge,
  sessionError,
  sessionFor,
  startSession,
  takeChallenge,
  updatePasskey,
  type PasskeyInfo,
} from "@/lib/auth";
import { allow } from "@/lib/ratelimit";
import { ownerHash, redis } from "@/lib/store";
import type { Result } from "./actions";

const UNAVAILABLE = { ok: false, error: "las passkeys no están disponibles en este deploy" } as const;
const BUSY = { ok: false, error: "demasiados intentos, probá en un rato" } as const;
const FAILED = { ok: false, error: "no pudimos verificar la passkey, probá de nuevo" } as const;

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const TRANSPORTS = ["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"];

/*
 * The editor fetches options ahead of the click, so the WebAuthn prompt opens straight from the
 * gesture (Safari refuses it once the user activation expires). Options only store a 5-minute
 * challenge, so they get their own, looser limit than the steps that check a credential.
 */

/** Step 1 of adding a passkey: only someone already editing the page may add one. */
export async function passkeyRegistrationOptions(
  raw: string,
): Promise<Result<{ options: PublicKeyCredentialCreationOptionsJSON; ticket: string }>> {
  if (!redis) return UNAVAILABLE;
  if (!(await allow("challenge", await headers()))) return BUSY;
  const session = await sessionFor(raw);
  if (typeof session === "string") return sessionError(session);
  const { rpID } = await relyingParty();
  const existing = await getPasskeys(session.handle);
  const options = await generateRegistrationOptions({
    rpName: "linkmi",
    rpID,
    userName: session.handle,
    userDisplayName: `linkmi · ${session.handle}`,
    userID: Buffer.from(await passkeyUserId(session.handle), "base64url"),
    attestationType: "none",
    excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports })),
    // Discoverable, so signing in needs no handle; synced passkeys survive a lost phone.
    // User verification (Face ID, fingerprint, PIN): a stolen or unlocked device is not enough on its own.
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  const ticket = await saveChallenge({ challenge: options.challenge, purpose: "register", handle: session.handle });
  return { ok: true, options, ticket };
}

/** Step 2 of adding a passkey. */
export async function registerPasskey(
  raw: string,
  ticket: string,
  response: RegistrationResponseJSON,
): Promise<Result<{ passkeys: PasskeyInfo[] }>> {
  if (!redis) return UNAVAILABLE;
  if (!(await allow("auth", await headers()))) return BUSY;
  const session = await sessionFor(raw);
  if (typeof session === "string") return sessionError(session);
  const pending = await takeChallenge("register", ticket);
  if (!pending || pending.handle !== session.handle) return FAILED;
  const { rpID, origin } = await relyingParty();
  let added: Awaited<ReturnType<typeof addPasskey>>;
  try {
    const { verified, registrationInfo } = await verifyRegistrationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
    if (!verified) return FAILED;
    const { credential, credentialBackedUp } = registrationInfo;
    // Both come from the browser unchecked: keep only what a real authenticator sends.
    if (!/^[A-Za-z0-9_-]{16,1023}$/.test(credential.id)) return FAILED;
    const transports = credential.transports?.filter((t) => TRANSPORTS.includes(t));
    added = await addPasskey(session, {
      id: credential.id,
      nonce: randomBytes(16).toString("base64url"),
      publicKey: b64url(credential.publicKey),
      counter: credential.counter,
      transports,
      label: await deviceLabel(),
      backedUp: credentialBackedUp,
      createdAt: Date.now(),
      lastUsedAt: null,
    });
  } catch {
    return FAILED;
  }
  if (added === "signed-out") return sessionError("none");
  if (added === "duplicate") return { ok: false, error: "esa passkey ya está guardada en esta página" };
  if (added === "full") return { ok: false, error: "esta página ya tiene 10 passkeys: borrá alguna antes de agregar otra" };
  return { ok: true, passkeys: await passkeyList(session) };
}

/** Step 1 of signing in: no handle needed, the browser offers the passkeys it has for this site. */
export async function passkeyLoginOptions(): Promise<
  Result<{ options: PublicKeyCredentialRequestOptionsJSON; ticket: string }>
> {
  if (!redis) return UNAVAILABLE;
  if (!(await allow("challenge", await headers()))) return BUSY;
  const { rpID } = await relyingParty();
  const options = await generateAuthenticationOptions({ rpID, userVerification: "required" });
  const ticket = await saveChallenge({ challenge: options.challenge, purpose: "login" });
  return { ok: true, options, ticket };
}

/** Step 2 of signing in: opens a session for the page the passkey belongs to. */
export async function signInWithPasskey(
  ticket: string,
  response: AuthenticationResponseJSON,
): Promise<Result<{ handle: string }>> {
  if (!redis) return UNAVAILABLE;
  if (!(await allow("auth", await headers()))) return BUSY;
  const pending = await takeChallenge("login", ticket);
  if (!pending) return FAILED;
  const userId = response.response.userHandle;
  const handle = userId ? await handleForPasskeyUser(userId) : null;
  const [stored, owner] = handle ? await Promise.all([getPasskey(handle, response.id), ownerHash(handle)]) : [null, null];
  if (!handle || !stored || !owner) {
    return { ok: false, error: "esa passkey ya no abre ninguna página: podés borrarla de tu llavero" };
  }
  const { rpID, origin } = await relyingParty();
  try {
    const { verified, authenticationInfo } = await verifyAuthenticationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: stored.id,
        publicKey: Buffer.from(stored.publicKey, "base64url"),
        counter: stored.counter,
        transports: stored.transports,
      },
      requireUserVerification: true,
    });
    if (!verified) return FAILED;
    const stillThere = await updatePasskey(handle, {
      ...stored,
      counter: authenticationInfo.newCounter,
      backedUp: authenticationInfo.credentialBackedUp,
      lastUsedAt: Date.now(),
    });
    if (!stillThere) return { ok: false, error: "esa passkey ya no abre ninguna página: podés borrarla de tu llavero" };
  } catch {
    return FAILED;
  }
  // Lives as long as this exact passkey: removing it ends this session on its next use.
  await startSession(handle, `passkey:${stored.id}`, stored.nonce);
  return { ok: true, handle };
}

export async function removePasskey(raw: string, id: string): Promise<Result<{ passkeys: PasskeyInfo[] }>> {
  if (!redis) return UNAVAILABLE;
  if (!(await allow("auth", await headers()))) return BUSY;
  const session = await sessionFor(raw);
  if (typeof session === "string") return sessionError(session);
  const removed = await deletePasskey(session, String(id));
  if (removed === "signed-out") return sessionError("none");
  if (removed === "outranked") {
    return {
      ok: false,
      error: session.passkeyId
        ? "solo podés borrar esta passkey o las que se agregaron después de ella"
        : "para borrar una passkey, entrá con una passkey",
    };
  }
  return { ok: true, passkeys: await passkeyList(session) };
}
