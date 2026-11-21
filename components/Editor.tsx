"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { upload } from "@vercel/blob/client";
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import {
  checkHandle,
  checkLink,
  loadPage,
  newEditLink,
  openWithLink,
  publishPage,
  resumeSession,
  saveChanges,
  signOut,
  signOutOthers,
  takeBackControl,
  type Access,
  type Result,
} from "@/app/editor/actions";
import {
  passkeyLoginOptions,
  passkeyRegistrationOptions,
  registerPasskey,
  removePasskey,
  signInWithPasskey,
} from "@/app/editor/passkeys";
import { normalizeHandle } from "@/lib/handles";
import LinkPage from "@/components/LinkPage";
import {
  BUTTONS,
  DEFAULT_CONFIG,
  FONTS,
  encodeConfig,
  normalizeConfig,
  uid,
  type ButtonStyle,
  type FontId,
  type PageConfig,
} from "@/lib/config";
import { SHADERS, type ShaderId } from "@/lib/shaders";

const DRAFT_KEY = "linkmi:draft";
// The page the draft belongs to, so opening another page never shows this draft as its unsaved changes.
const DRAFT_FOR_KEY = "linkmi:draft-for";
// Older editors kept the edit token here; it is traded once for a session cookie, then deleted.
const OWNED_KEY = "linkmi:owned";
// Pre-rename keys, read once so existing drafts and edit access survive.
const LEGACY_KEYS: Record<string, string> = { [DRAFT_KEY]: "micelio:draft", [OWNED_KEY]: "micelio:owned" };
const readKey = (key: string) => localStorage.getItem(key) ?? localStorage.getItem(LEGACY_KEYS[key]);

type Credential = { handle: string; token: string };
type StoredCredential = Credential & { key: string };

/** An edit link (`/editor?h=handle#k=token`). It stays in the address bar until the trade settles. */
function readLinkCredential(): Credential | null {
  const handle = new URLSearchParams(window.location.search).get("h");
  const token = new URLSearchParams(window.location.hash.slice(1)).get("k");
  return handle && token ? { handle: normalizeHandle(handle), token } : null;
}

// Back to plain /editor, so pasting an edit link into this tab is a real navigation, not just a new #hash.
const wipeLinkFromUrl = () => window.history.replaceState(null, "", "/editor");

const switchQuestion = (current: string, next: string) =>
  `Este navegador está editando /${current}. ¿Pasar a /${next}? ` +
  `Para volver a /${current} vas a necesitar su link de edición o una passkey.`;

function readDraftFor(): string | null {
  try {
    return localStorage.getItem(DRAFT_FOR_KEY);
  } catch {
    return null;
  }
}

function readStoredCredential(): StoredCredential | null {
  try {
    for (const key of [OWNED_KEY, LEGACY_KEYS[OWNED_KEY]]) {
      const saved = JSON.parse(localStorage.getItem(key) ?? "null");
      if (saved?.handle && saved?.token) return { handle: String(saved.handle), token: String(saved.token), key };
    }
  } catch {}
  return null;
}

/** Only the key that was read: another one may hold a different page's token, not shown yet. */
function forgetStoredCredential(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {}
}

type PasskeyInfo = Access["passkeys"][number];

// Prefetched WebAuthn options are reused while their 5-minute challenge is comfortably alive.
const OPTIONS_FRESH_MS = 4 * 60 * 1000;
const stillFresh = (at: number) => Date.now() - at < OPTIONS_FRESH_MS;

const shortDate = (ms: number) => new Date(ms).toLocaleDateString("es-AR", { day: "numeric", month: "short" });

const label = "font-mono text-[10px] uppercase tracking-[0.18em] text-white/45";
// text-base on phones: iOS Safari zooms into inputs smaller than 16px.
const input =
  "w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-base text-white placeholder:text-white/25 outline-none transition-colors focus:border-white/35 lg:text-sm";
const chip = (on: boolean) =>
  `rounded-lg border px-3 py-2 text-xs transition-colors ${
    on ? "border-white/60 bg-white/10 text-white" : "border-white/10 text-white/55 hover:border-white/25 hover:text-white"
  }`;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-white/[0.07] py-6">
      <h2 className={label}>{title}</h2>
      {children}
    </section>
  );
}

/** Stable comparison key, so key order or defaults filled in by the server don't count as edits. */
const fingerprint = (c: PageConfig) => JSON.stringify(normalizeConfig(c));

function loadDraft(): PageConfig {
  try {
    const saved = readKey(DRAFT_KEY);
    if (saved) return normalizeConfig(JSON.parse(saved));
  } catch {}
  return DEFAULT_CONFIG;
}

// `storedKey`: the localStorage key still holding this link, forgotten only once it is copied or saved.
type FreshLink = { url: string; handle: string; migrated: boolean; storedKey?: string };

/** Client-only (reads localStorage on first render); mounted via next/dynamic with ssr: false. */
export default function Editor({
  canPublish,
  canUpload,
  contact,
}: {
  canPublish: boolean;
  canUpload: boolean;
  contact?: string;
}) {
  const [config, setConfig] = useState<PageConfig>(loadDraft);
  // The page this browser may edit, as confirmed by the server; null while checking or signed out.
  const [owned, setOwned] = useState<Access | null>(null);
  const [checking, setChecking] = useState(canPublish);
  // An edit link is shown once (after publishing, replacing it, or taking over a token an older editor
  // kept); nothing keeps it afterwards.
  const [freshLink, setFreshLink] = useState<FreshLink | null>(null);
  const [linkSaved, setLinkSaved] = useState(false);
  // A stored or linked credential could not be traded yet (rate limit, network): don't publish over it.
  const [retryLater, setRetryLater] = useState(false);
  const [canPasskey] = useState(browserSupportsWebAuthn);
  const [authBusy, setAuthBusy] = useState(false);
  // The page whose session ended mid-edit: its draft stays protected, and signing back in keeps it.
  const [lost, setLost] = useState<string | null>(null);
  // `?claim=name` comes from the 404 of a free handle.
  const [handle, setHandle] = useState(() => normalizeHandle(new URLSearchParams(window.location.search).get("claim") ?? ""));
  const [handleStatus, setHandleStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; msg: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState<string | null>(null);
  // Phones show one pane at a time; desktop always shows both side by side.
  const [mobileView, setMobileView] = useState<"edit" | "preview">("edit");
  const [lt, setLt] = useState("");
  const [importState, setImportState] = useState<"idle" | "loading" | string>("idle");
  // What the published page currently holds; null until known.
  const [savedPrint, setSavedPrint] = useState<string | null>(null);
  const [removed, setRemoved] = useState<{ link: PageConfig["links"][number]; index: number } | null>(null);
  const dirty = (owned !== null || lost !== null) && savedPrint !== null && fingerprint(config) !== savedPrint;

  // Unsaved changes, or an edit link shown once and never copied.
  const mustWarn = dirty || (freshLink !== null && !linkSaved);
  useEffect(() => {
    if (!mustWarn) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [mustWarn]);

  useEffect(() => {
    if (!removed) return;
    const id = setTimeout(() => setRemoved(null), 5000);
    return () => clearTimeout(id);
  }, [removed]);

  const removeLink = (i: number) => {
    setRemoved({ link: config.links[i], index: i });
    set("links", config.links.filter((_, j) => j !== i));
  };

  const undoRemove = () => {
    if (!removed) return;
    const next = [...config.links];
    next.splice(Math.min(removed.index, next.length), 0, removed.link);
    set("links", next);
    setRemoved(null);
  };

  const draftFor = owned?.handle ?? lost ?? "";
  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(config));
      if (!checking) localStorage.setItem(DRAFT_FOR_KEY, draftFor);
    } catch {}
  }, [config, draftFor, checking]);

  // Pasting an edit link into this tab only changes the #hash; reload so it gets traded.
  useEffect(() => {
    const onHash = () => window.location.hash.includes("k=") && window.location.reload();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const set = <K extends keyof PageConfig>(key: K, value: PageConfig[K]) =>
    setConfig((c) => ({ ...c, [key]: value }));

  const setLink = (id: string, patch: Partial<{ title: string; url: string }>) =>
    set("links", config.links.map((l) => (l.id === id ? { ...l, ...patch } : l)));

  const moveLink = (i: number, dir: -1 | 1) => {
    const next = [...config.links];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    set("links", next);
  };

  const origin = () => window.location.origin;
  const encodedUrl = () => `${origin()}/p#${encodeConfig(config)}`;
  const publicUrl = (o: Access) => `${origin()}/${o.handle}`;
  const editUrl = (h: string, token: string) => `${origin()}/editor?h=${h}#k=${token}`;

  const offerLink = (h: string, token: string, migrated: boolean, storedKey?: string) => {
    setFreshLink({ url: editUrl(h, token), handle: h, migrated, storedKey });
    setLinkSaved(false);
  };

  // Shown is not saved: a token an older editor kept is only forgotten once the person copies it or says so.
  const linkIsSaved = () => {
    setLinkSaved(true);
    if (freshLink?.storedKey) forgetStoredCredential(freshLink.storedKey);
  };

  // Opening a page loads what is published; a returning session keeps the local draft if it is for this page.
  const syncPublished = async (h: string, replace: boolean) => {
    const published = await loadPage(h);
    if (!published) return;
    if (replace) setConfig(published);
    setSavedPrint(fingerprint(published));
  };

  // Who may edit: the session cookie, an edit link in the address bar, and a token an older editor left in
  // localStorage. That token is only forgotten once it was traded, shown, or the server said it is dead.
  const started = useRef(false);
  useEffect(() => {
    if (!canPublish || started.current) return;
    started.current = true;
    const fromLink = readLinkCredential();
    const stored = readStoredCredential();
    const say = (msg: string) => setNotice({ ok: false, msg });
    (async () => {
      try {
        let access = await resumeSession();
        let opened = false;

        if (fromLink) {
          if (access?.handle === fromLink.handle) opened = true;
          else if (access && !window.confirm(switchQuestion(access.handle, fromLink.handle))) {
            say(`seguís editando /${access.handle}; para pasar a /${fromLink.handle}, abrí su link de nuevo`);
          } else {
            const res = await openWithLink(fromLink.handle, fromLink.token);
            if (res.ok) {
              access = await resumeSession();
              if (access?.handle === res.handle) opened = true;
              else say("este navegador no guarda la sesión: abrí tu link en Safari o Chrome");
            } else if ("invalid" in res) {
              say("ese link de edición ya no funciona: puede que se haya generado uno nuevo");
            } else {
              setRetryLater(true);
              say(`no pudimos abrir /${fromLink.handle} ahora; está a salvo, recargá en un rato`);
              return; // keep the link in the address bar, and any stored token, for the retry
            }
          }
          wipeLinkFromUrl();
        }

        if (stored) {
          // Never traded over a live session (it is only checked then); without one, it opens its page.
          const res = access
            ? await checkLink(stored.handle, stored.token)
            : await openWithLink(stored.handle, stored.token);
          if (res.ok) {
            // Older editors could show the link any time, so many people never saved it: show it until saved.
            offerLink(res.handle, stored.token, true, stored.key);
            if (!access) {
              access = await resumeSession();
              if (!access) say("este navegador no guarda la sesión: guardá tu link y abrilo en Safari o Chrome");
            }
          } else if ("invalid" in res) {
            forgetStoredCredential(stored.key);
            say(`este navegador tenía guardado un acceso a /${stored.handle} que ya no funciona`);
          } else if (!access) {
            setRetryLater(true);
            say(`no pudimos abrir /${stored.handle} ahora; está a salvo, recargá en un rato`);
          }
        }

        setOwned(access);
        if (access) {
          const savedFor = readDraftFor();
          // An older editor left no owner on its draft: keep it, as it always did.
          await syncPublished(access.handle, opened || (savedFor !== null && savedFor !== access.handle));
        }
      } catch {
        setRetryLater(true);
        setNotice({ ok: false, msg: "no pudimos conectar con linkmi: recargá para reintentar" });
      } finally {
        setChecking(false);
      }
    })();
    // Runs once per mount (guarded by `started`); the helpers it calls only use state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canPublish]);

  // Debounced availability check while typing a handle.
  useEffect(() => {
    if (!canPublish || owned || !handle) return;
    const id = setTimeout(async () => {
      const res = await checkHandle(handle);
      setHandleStatus(res.ok ? { ok: true, msg: "disponible" } : { ok: false, msg: res.error });
    }, 400);
    return () => clearTimeout(id);
  }, [handle, canPublish, owned]);

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Some in-app browsers block the clipboard; the text stays selectable.
      return setNotice({ ok: false, msg: "no pudimos copiar: seleccioná el texto y copialo a mano" });
    }
    if (key === "edit") linkIsSaved();
    setCopied(key);
    setTimeout(() => setCopied(null), 1600);
  };

  // The server says this browser can no longer edit the page: drop it but keep the draft protected.
  const signedOut = (res: { signedOut?: true }) => {
    if (!res.signedOut || !owned) return;
    setLost(owned.handle);
    setOwned(null);
  };

  const failed = (res: { error: string; signedOut?: true }) => {
    signedOut(res);
    return res.error;
  };

  const publish = async () => {
    if (!handle) {
      setNotice({ ok: false, msg: "elegí un nombre para tu página" });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const res = await publishPage(handle, config);
      if (!res.ok) return setNotice({ ok: false, msg: res.error });
      setSavedPrint(fingerprint(config));
      setLost(null);
      offerLink(res.handle, res.token, false);
      // The session is confirmed rather than assumed: it may not have stuck. The link is shown either way.
      const access = await resumeSession();
      setOwned(access);
      if (!access) setNotice({ ok: false, msg: "este navegador no guarda la sesión: guardá tu link y abrilo en Safari o Chrome" });
    } catch {
      setNotice({ ok: false, msg: "no pudimos publicar: revisá tu conexión y probá de nuevo" });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!owned) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await saveChanges(owned.handle, config);
      if (res.ok) setSavedPrint(fingerprint(config));
      else signedOut(res);
      setNotice(res.ok ? { ok: true, msg: "cambios guardados" } : { ok: false, msg: res.error });
    } catch {
      setNotice({ ok: false, msg: "no pudimos guardar: revisá tu conexión y probá de nuevo" });
    } finally {
      setBusy(false);
    }
  };

  const leave = async () => {
    if (!owned) return;
    const synced = owned.passkeys.some((p) => p.backedUp);
    const warning = owned.passkeys.length
      ? `Tu passkey no está sincronizada: para volver a editar /${owned.handle} desde otro dispositivo vas a necesitar tu link de edición. ¿Salir igual?`
      : `Para volver a editar /${owned.handle} vas a necesitar tu link de edición. ¿Salir igual?`;
    if (!synced && !window.confirm(warning)) return;
    if (freshLink && !linkSaved && !window.confirm("No copiaste el link de edición que te mostramos. ¿Salir igual?")) return;
    await signOut(owned.handle);
    wipeLinkFromUrl();
    setLost(null);
    setOwned(null);
    setSavedPrint(null);
    setFreshLink(null);
  };

  // WebAuthn options fetched ahead of the click (see app/editor/passkeys.ts), refreshed before they expire.
  type Ready = { key: string; options: unknown; ticket: string; at: number };
  const ready = useRef<Ready | null>(null);
  // Not refreshed mid-ceremony: the prefetched options are what the click is about to use.
  const inCeremony = useRef(false);
  const [round, setRound] = useState(0);
  const ceremonyKey = !canPasskey || checking ? null : owned ? `register:${owned.handle}` : "login";
  useEffect(() => {
    if (!ceremonyKey) return;
    // Hidden tabs don't prefetch (each round costs Redis commands); coming back refreshes stale options.
    const prefetch = async () => {
      if (inCeremony.current || document.hidden) return;
      try {
        const res =
          ceremonyKey === "login"
            ? await passkeyLoginOptions()
            : await passkeyRegistrationOptions(ceremonyKey.slice("register:".length));
        ready.current = res.ok ? { key: ceremonyKey, options: res.options, ticket: res.ticket, at: Date.now() } : null;
      } catch {
        ready.current = null;
      }
    };
    const onVisible = () => !document.hidden && !(ready.current && stillFresh(ready.current.at)) && prefetch();
    prefetch();
    const id = setInterval(prefetch, OPTIONS_FRESH_MS);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ceremonyKey, round]);

  /** Prefetched options if still fresh, else fetched now (the prompt may then need a second tap on Safari). */
  type Options<T> = Result<{ options: T; ticket: string }>;
  const optionsFor = async <T,>(key: string, fetchNow: () => Promise<Options<T>>): Promise<Options<T>> => {
    const r = ready.current;
    ready.current = null;
    if (r && r.key === key && stillFresh(r.at)) return { ok: true, options: r.options as T, ticket: r.ticket };
    return fetchNow();
  };

  // Runs a credential change and reports failures. A closed prompt reads the same as an in-app browser
  // refusing WebAuthn, so both get the hint.
  const authStep = async (step: () => Promise<string | null>) => {
    setAuthBusy(true);
    setNotice(null);
    inCeremony.current = true;
    try {
      const error = await step();
      if (error) setNotice({ ok: false, msg: error });
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      if (name === "InvalidStateError") setNotice({ ok: false, msg: "este dispositivo ya tiene una passkey para esta página" });
      else if (name === "NotAllowedError")
        setNotice({ ok: false, msg: "no se completó la passkey; si estás en Instagram o TikTok, abrí linkmi en Safari o Chrome" });
      else if (name !== "AbortError") setNotice({ ok: false, msg: "no se pudo usar la passkey" });
    }
    inCeremony.current = false;
    setAuthBusy(false);
    // Each challenge is single-use: fetch the next one now that this ceremony is over.
    setRound((n) => n + 1);
  };

  const addPasskey = () =>
    authStep(async () => {
      const h = owned!.handle;
      const opts = await optionsFor(`register:${h}`, () => passkeyRegistrationOptions(h));
      if (!opts.ok) return failed(opts);
      const res = await registerPasskey(h, opts.ticket, await startRegistration({ optionsJSON: opts.options }));
      if (!res.ok) return failed(res);
      setOwned((o) => o && { ...o, passkeys: res.passkeys });
      const added = res.passkeys[res.passkeys.length - 1];
      setNotice({
        ok: true,
        msg: added?.backedUp
          ? "passkey guardada y sincronizada con tu llavero"
          : "passkey guardada, pero no sincronizada: guardá también tu link o agregá otra",
      });
      return null;
    });

  const passkeySignIn = () =>
    authStep(async () => {
      const opts = await optionsFor("login", passkeyLoginOptions);
      if (!opts.ok) return opts.error;
      const res = await signInWithPasskey(opts.ticket, await startAuthentication({ optionsJSON: opts.options }));
      if (!res.ok) return res.error;
      const access = await resumeSession();
      if (!access) return "este navegador no guarda la sesión: abrí linkmi en Safari o Chrome";
      // Back on the page whose session ended mid-edit: keep the unsaved draft.
      const keepDraft = lost === access.handle;
      setLost(null);
      setRetryLater(false);
      setOwned(access);
      await syncPublished(access.handle, !keepDraft);
      return null;
    });

  const dropPasskey = (p: PasskeyInfo) =>
    authStep(async () => {
      const others = owned!.passkeys.length - 1;
      const warning = p.current
        ? `¿Borrar la passkey con la que entraste (${p.label})? Vas a salir: para volver vas a necesitar tu link de edición u otra passkey.`
        : others
          ? `¿Borrar la passkey de ${p.label}? Ese dispositivo ya no va a poder entrar.`
          : `¿Borrar la passkey de ${p.label}? Te queda solo el link de edición para entrar.`;
      if (!window.confirm(warning)) return null;
      const res = await removePasskey(owned!.handle, p.id);
      if (!res.ok) return failed(res);
      // Removing the passkey that opened this session ends it on the next request.
      if (p.current) {
        setLost(owned!.handle);
        setOwned(null);
        return "borraste la passkey con la que entraste: volvé a entrar con otra o con tu link";
      }
      setOwned((o) => o && { ...o, passkeys: res.passkeys });
      return null;
    });

  const replaceLink = () =>
    authStep(async () => {
      const warning =
        "El link de edición actual va a dejar de funcionar para todos los que lo usan, también para quienes lo " +
        "compartiste. Las passkeys siguen funcionando. ¿Seguir?";
      if (!window.confirm(warning)) return null;
      const res = await newEditLink(owned!.handle);
      if (!res.ok) return failed(res);
      setOwned(res.access);
      offerLink(res.access.handle, res.token, false);
      return null;
    });

  const recover = () =>
    authStep(async () => {
      const warning =
        "Se borran las passkeys agregadas después de la tuya, el link de edición deja de funcionar (te mostramos " +
        "uno nuevo) y se cierran las sesiones abiertas con ellos. ¿Seguir?";
      if (!window.confirm(warning)) return null;
      const res = await takeBackControl(owned!.handle);
      if (!res.ok) return failed(res);
      setOwned(res.access);
      offerLink(res.access.handle, res.token, false);
      return null;
    });

  const closeOthers = () =>
    authStep(async () => {
      const res = await signOutOthers(owned!.handle);
      if (!res.ok) return failed(res);
      setOwned(res.access);
      return null;
    });

  const uploadAvatar = async (file: File) => {
    if (file.size > 2 * 1024 * 1024) return setNotice({ ok: false, msg: "la foto tiene que pesar menos de 2 MB" });
    setUploading(true);
    try {
      const blob = await upload(`avatars/${file.name}`, file, { access: "public", handleUploadUrl: "/api/upload" });
      set("avatar", blob.url);
    } catch {
      setNotice({ ok: false, msg: "no se pudo subir la foto" });
    }
    setUploading(false);
  };

  const downloadConfig = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(config, null, 2)], { type: "application/json" }));
    a.download = "linkmi.config.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importLinktree = async () => {
    const u = lt.trim().replace(/^https?:\/\/(www\.)?linktr\.ee\//, "").replace(/\/$/, "");
    if (!u) return;
    setImportState("loading");
    try {
      const res = await fetch(`/api/import?u=${encodeURIComponent(u)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setConfig((c) => normalizeConfig({ ...c, ...data, links: data.links.map((l: object) => ({ ...l, id: uid() })) }));
      setImportState("idle");
    } catch (e) {
      setImportState(e instanceof Error ? e.message : "error");
    }
  };

  return (
    <div className="grid min-h-dvh lg:h-dvh lg:grid-cols-[440px_1fr]">
      {/* preview */}
      <div
        className={`${mobileView === "preview" ? "fixed inset-x-0 top-0 bottom-20" : "hidden"} overflow-hidden lg:relative lg:inset-auto lg:order-2 lg:block lg:h-full`}
      >
        <LinkPage config={config} contained footer={false} />
      </div>

      {/* controls */}
      <aside
        className={`${mobileView === "edit" ? "" : "hidden"} relative border-white/[0.07] bg-[#0b0a10] px-5 pb-32 lg:order-1 lg:block lg:overflow-y-auto lg:border-r`}
      >
        <header className="flex items-center justify-between py-6">
          <Link href="/" className="font-serif text-2xl italic">
            linkmi
          </Link>
          <span className={label}>{checking ? "…" : owned ? `editando /${owned.handle}` : "editor"}</span>
        </header>

        <Section title={owned ? "Tu página" : "Publicar"}>
          {freshLink ? (
            <div
              role="alert"
              className="flex flex-col gap-2 rounded-xl border border-amber-200/25 bg-amber-200/[0.06] p-3 text-xs leading-relaxed text-amber-100/90"
            >
              {freshLink.migrated ? (
                <p>
                  Este es tu <strong>link de edición</strong> de /{freshLink.handle}. Antes el editor lo guardaba por
                  vos; ahora guardalo vos (o agregá una passkey). Quien lo tenga puede editar la página.
                </p>
              ) : (
                <p>
                  Guardá tu <strong>link de edición</strong> ahora: es la única vez que lo vas a ver. Quien lo tenga
                  puede editar esta página, así que no lo compartas.
                </p>
              )}
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  aria-label="link de edición"
                  value={freshLink.url}
                  // iOS ignores select() on read-only inputs.
                  onFocus={(e) => e.target.setSelectionRange(0, e.target.value.length)}
                  className="min-w-0 flex-1 rounded-md bg-black/20 px-2 py-1.5 font-mono text-[11px] text-amber-100/70 outline-none"
                />
                <button className={chip(false)} onClick={() => copy(freshLink.url, "edit")}>
                  {copied === "edit" ? "¡copiado!" : "copiar"}
                </button>
              </div>
              {!linkSaved ? (
                <button className="self-start underline underline-offset-4 hover:text-white" onClick={linkIsSaved}>
                  ya lo guardé
                </button>
              ) : null}
            </div>
          ) : null}
          {canPublish && owned ? (
            <>
              <a href={publicUrl(owned)} target="_blank" className="truncate text-sm text-white underline-offset-4 hover:underline">
                {publicUrl(owned).replace(/^https?:\/\//, "")} ↗
              </a>
              {canPasskey && !owned.passkeys.length ? (
                <div className="flex flex-col items-start gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-xs leading-relaxed text-white/70">
                  <p>
                    Guardá esta página en tu llavero con una <strong>passkey</strong>: entrás con Face ID, Touch ID o el
                    PIN de tu dispositivo, aunque pierdas el link. Si tu llavero se sincroniza (iCloud, Google), sirve en
                    todos tus dispositivos.
                  </p>
                  <button className={chip(false)} onClick={addPasskey} disabled={authBusy} aria-busy={authBusy}>
                    guardar con passkey
                  </button>
                </div>
              ) : null}
              <div className="flex gap-2">
                <button className={chip(false)} onClick={leave}>
                  crear otra
                </button>
              </div>
            </>
          ) : canPublish ? (
            <>
              <div className="flex items-center rounded-lg border border-white/10 bg-white/[0.04] pl-3 text-base lg:text-sm focus-within:border-white/35">
                <span className="text-white/35">{typeof window !== "undefined" ? window.location.host : ""}/</span>
                <input
                  className="w-full bg-transparent py-2 pr-3 text-white outline-none placeholder:text-white/25"
                  placeholder="tunombre"
                  value={handle}
                  onChange={(e) => {
                    setHandle(normalizeHandle(e.target.value));
                    setHandleStatus(null);
                  }}
                  onKeyDown={(e) => e.key === "Enter" && publish()}
                />
              </div>
              {handleStatus ? (
                <p className={`text-xs ${handleStatus.ok ? "text-emerald-300/80" : "text-red-300/80"}`}>{handleStatus.msg}</p>
              ) : null}
              {canPasskey && !checking ? (
                <p className="text-xs text-white/45">
                  ¿Ya tenés una página? Abrí tu link de edición o{" "}
                  <button
                    className="underline underline-offset-4 hover:text-white"
                    onClick={passkeySignIn}
                    disabled={authBusy}
                  >
                    entrá con tu passkey
                  </button>
                  .
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-xs leading-relaxed text-white/45">
              Este deploy no tiene base de datos: compartí tu página con el link codificado o descargá la config para tu
              propio deploy.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button className={chip(false)} onClick={() => copy(encodedUrl(), "encoded")}>
              {copied === "encoded" ? "¡copiado!" : "link sin cuenta"}
            </button>
            <button className={chip(false)} onClick={downloadConfig}>
              descargar config
            </button>
          </div>
        </Section>

        {canPublish && owned ? (
          <Section title="Acceso">
            {owned.passkeys.length ? (
              <ul className="flex flex-col gap-1.5">
                {owned.passkeys.map((p) => (
                  <li key={p.id} className="flex items-center gap-2 text-xs text-white/70">
                    <span className="flex-1">
                      passkey · {p.label} · {p.backedUp ? "sincronizada" : "no sincronizada"} · desde{" "}
                      {shortDate(p.createdAt)}
                      {p.current ? <span className="text-white/55"> · con esta entraste</span> : null}
                    </span>
                    {p.removable ? (
                      <button
                        aria-label={`borrar passkey de ${p.label}`}
                        className="flex h-8 w-8 items-center justify-center rounded-md text-white/55 hover:text-red-300"
                        onClick={() => dropPasskey(p)}
                        disabled={authBusy}
                      >
                        ×
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-white/45">Sin passkeys: hoy solo se entra con el link de edición.</p>
            )}
            <div className="flex flex-wrap gap-2">
              {canPasskey && owned.passkeys.length ? (
                <button className={chip(false)} onClick={addPasskey} disabled={authBusy}>
                  agregar passkey
                </button>
              ) : null}
              <button className={chip(false)} onClick={replaceLink} disabled={authBusy}>
                generar link nuevo
              </button>
              {owned.passkeys.some((p) => p.current) ? (
                <button className={chip(false)} onClick={recover} disabled={authBusy}>
                  recuperar el control
                </button>
              ) : null}
              {owned.otherSessions ? (
                <button className={chip(false)} onClick={closeOthers} disabled={authBusy}>
                  cerrar sesión en {owned.otherSessions} {owned.otherSessions === 1 ? "navegador" : "navegadores"} más
                </button>
              ) : null}
            </div>
            <p className="text-xs leading-relaxed text-white/55">
              ¿No tenés tu link? Generá uno nuevo: el anterior deja de funcionar. Si alguien más entró con tu
              link, entrá con tu passkey y usá recuperar el control.
              {owned.passkeys.length && !owned.passkeys.some((p) => p.removable)
                ? ` Las passkeys se borran entrando con una passkey, y cada una solo puede borrar las agregadas después.${
                    contact ? ` Si perdiste el dispositivo de la más vieja, escribí a ${contact}.` : ""
                  }`
                : ""}
            </p>
          </Section>
        ) : null}

        <Section title="Importar de Linktree">
          <div className="flex gap-2">
            <input
              className={input}
              placeholder="usuario o linktr.ee/usuario"
              value={lt}
              onChange={(e) => setLt(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && importLinktree()}
            />
            <button onClick={importLinktree} className={chip(false)} disabled={importState === "loading"}>
              {importState === "loading" ? "…" : "importar"}
            </button>
          </div>
          {importState !== "idle" && importState !== "loading" ? (
            <p className="text-xs text-red-300/80">{importState}</p>
          ) : null}
        </Section>

        <Section title="Perfil">
          <input className={input} placeholder="nombre" value={config.name} onChange={(e) => set("name", e.target.value)} />
          <textarea
            className={`${input} min-h-16 resize-none`}
            placeholder="bio"
            value={config.bio}
            onChange={(e) => set("bio", e.target.value)}
          />
          <div className="flex gap-2">
            <input
              className={input}
              placeholder="URL de tu foto (https://…)"
              value={config.avatar}
              onChange={(e) => set("avatar", e.target.value)}
            />
            {canUpload ? (
              <>
                <button className={chip(false)} onClick={() => fileRef.current?.click()} disabled={uploading}>
                  {uploading ? "…" : "subir"}
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
                  hidden
                  onChange={(e) => e.target.files?.[0] && uploadAvatar(e.target.files[0])}
                />
              </>
            ) : null}
          </div>
        </Section>

        <Section title="Links">
          <ul className="flex flex-col gap-2">
            {config.links.map((l, i) => (
              <li key={l.id} className="flex gap-2 rounded-xl border border-white/[0.07] p-2">
                <div className="flex flex-1 flex-col gap-1.5">
                  <input className={input} placeholder="título" value={l.title} onChange={(e) => setLink(l.id, { title: e.target.value })} />
                  <input className={input} placeholder="https://" value={l.url} onChange={(e) => setLink(l.id, { url: e.target.value })} />
                </div>
                <div className="flex flex-col justify-between text-white/40">
                  <div className="flex flex-col">
                    <button aria-label="subir" className="px-1.5 py-0.5 hover:text-white" onClick={() => moveLink(i, -1)}>↑</button>
                    <button aria-label="bajar" className="px-1.5 py-0.5 hover:text-white" onClick={() => moveLink(i, 1)}>↓</button>
                  </div>
                  <button aria-label="eliminar" className="px-1.5 py-0.5 hover:text-red-300" onClick={() => removeLink(i)}>
                    ×
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <button
            className="rounded-xl border border-dashed border-white/15 py-3 text-xs text-white/55 transition-colors hover:border-white/35 hover:text-white"
            onClick={() => set("links", [...config.links, { id: uid(), title: "", url: "" }])}
          >
            + agregar link
          </button>
        </Section>

        <Section title="Fondo">
          <div className="grid grid-cols-3 gap-2">
            {(Object.keys(SHADERS) as ShaderId[]).map((id) => (
              <button
                key={id}
                className={`${chip(config.shader === id)} flex flex-col gap-1.5 text-left`}
                onClick={() => setConfig((c) => ({ ...c, shader: id, colors: SHADERS[id].palette }))}
              >
                <span
                  aria-hidden
                  className="h-1.5 w-full rounded-full"
                  style={{ background: `linear-gradient(90deg, ${SHADERS[id].palette.join(", ")})` }}
                />
                {SHADERS[id].label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3 pt-1">
            {config.colors.map((c, i) => (
              <label key={i} className="relative h-9 w-9 cursor-pointer overflow-hidden rounded-full ring-1 ring-white/20">
                <input
                  type="color"
                  value={c}
                  aria-label={`color ${i + 1}`}
                  className="absolute -inset-2 h-14 w-14 cursor-pointer"
                  onChange={(e) => {
                    const next = [...config.colors] as PageConfig["colors"];
                    next[i] = e.target.value;
                    set("colors", next);
                  }}
                />
              </label>
            ))}
            <span className="ml-auto text-xs text-white/40">velocidad</span>
            <input
              type="range"
              min={0}
              max={3}
              step={0.1}
              value={config.speed}
              onChange={(e) => set("speed", Number(e.target.value))}
              className="w-24 accent-white"
            />
          </div>
        </Section>

        <Section title="Tipografía">
          <div className="grid grid-cols-2 gap-2">
            {(Object.keys(FONTS) as FontId[]).map((id) => (
              <button
                key={id}
                className={`${chip(config.font === id)} text-base`}
                style={{ fontFamily: FONTS[id].display, fontStyle: FONTS[id].italic ? "italic" : "normal" }}
                onClick={() => set("font", id)}
              >
                {FONTS[id].label}
              </button>
            ))}
          </div>
        </Section>

        <Section title="Botones">
          <div className="grid grid-cols-4 gap-2">
            {(Object.keys(BUTTONS) as ButtonStyle[]).map((id) => (
              <button key={id} className={chip(config.button === id)} onClick={() => set("button", id)}>
                {BUTTONS[id]}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-white/40">bordes</span>
            <input
              type="range"
              min={0}
              max={32}
              value={config.radius}
              onChange={(e) => set("radius", Number(e.target.value))}
              className="flex-1 accent-white"
            />
          </div>
          <div className="flex gap-2">
            <button className={chip(config.ink === "light")} onClick={() => set("ink", "light")}>texto claro</button>
            <button className={chip(config.ink === "dark")} onClick={() => set("ink", "dark")}>texto oscuro</button>
            <button className={chip(config.showIndex)} onClick={() => set("showIndex", !config.showIndex)}>01 02 03</button>
          </div>
        </Section>
      </aside>

      <div className="fixed inset-x-0 bottom-0 z-10 flex flex-col gap-2 border-t border-white/[0.07] bg-[#0b0a10]/90 p-4 backdrop-blur lg:w-[440px]">
        {/* Always mounted, so screen readers announce what appears in it. */}
        <div role="status" aria-live="polite" className="empty:hidden">
          {removed ? (
            <p className="flex items-center gap-3 text-xs text-white/70">
              link eliminado
              <button onClick={undoRemove} className="underline underline-offset-4 hover:text-white">
                deshacer
              </button>
            </p>
          ) : notice && !(notice.ok && dirty) ? (
            <p className={`text-xs ${notice.ok ? "text-emerald-300/80" : "text-red-300/80"}`}>
              {notice.msg}
            </p>
          ) : dirty ? (
            <p className="text-xs text-amber-200/80">
              cambios sin guardar
            </p>
          ) : null}
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setMobileView((v) => (v === "edit" ? "preview" : "edit"))}
            className="rounded-xl border border-white/15 px-4 text-sm text-white/80 transition-colors hover:border-white/40 lg:hidden"
          >
            {mobileView === "edit" ? "vista previa" : "editar"}
          </button>
          <button
            onClick={canPublish ? (owned ? save : publish) : () => copy(encodedUrl(), "main")}
            disabled={busy || checking || (!owned && retryLater) || (owned !== null && savedPrint !== null && !dirty)}
            aria-busy={busy || checking}
            className="flex-1 rounded-xl bg-white py-3 text-sm font-medium text-black transition-transform active:scale-[0.98] disabled:opacity-60"
          >
            {busy
              ? "…"
              : canPublish
                ? owned
                  ? savedPrint !== null && !dirty
                    ? "guardado ✓"
                    : "guardar cambios"
                  : "publicar"
                : copied === "main"
                  ? "¡copiado!"
                  : "copiar mi link"}
          </button>
          <button
            onClick={() => window.open(owned ? publicUrl(owned) : encodedUrl(), "_blank", "noopener")}
            aria-label="abrir página publicada"
            className="rounded-xl border border-white/15 px-4 text-sm text-white/80 transition-colors hover:border-white/40"
          >
            ↗
          </button>
        </div>
      </div>
    </div>
  );
}
