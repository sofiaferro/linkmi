"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import ShaderCanvas from "./ShaderCanvas";
import { handleError, normalizeHandle } from "@/lib/handles";

const COLORS: [string, string, string] = ["#0a0a0a", "#161616", "#a9cf2f"];

/** 404 for profiles: if the path is a claimable handle, offer to create it. */
export default function NotFound() {
  const raw = decodeURIComponent(usePathname().split("/")[1] ?? "");
  const handle = normalizeHandle(raw);
  const claimable = handle !== "" && handleError(handle) === null;

  return (
    <div className="relative min-h-dvh overflow-hidden bg-[#0a0a0a]">
      <ShaderCanvas shader="caustics" colors={COLORS} speed={0.6} className="fixed inset-0 h-full w-full" />
      <main className="home-copy relative flex min-h-dvh flex-col items-center justify-center gap-6 px-4 text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-white/50">404</p>
        <h1 className="font-serif text-5xl leading-none tracking-tight italic sm:text-6xl">
          {claimable ? "esta página no existe" : "no encontramos esto"}
          {claimable ? <span className="text-[#d4ff3a]"> (todavía)</span> : null}
        </h1>
        {claimable ? (
          <p className="max-w-sm text-[15px] leading-relaxed text-white/65">
            El nombre <span className="font-mono text-white">/{handle}</span> está libre. Podés quedártelo ahora.
          </p>
        ) : null}
        <div className="mt-2 flex flex-wrap justify-center gap-3">
          {/* Full page load, not <Link>: the editor's CSP (proxy.ts) only covers documents it serves. */}
          <a
            href={claimable ? `/editor?claim=${encodeURIComponent(handle)}` : "/editor"}
            className="rounded-full bg-white px-6 py-3 text-sm font-medium text-black transition-transform active:scale-[0.97]"
          >
            {claimable ? `crear /${handle}` : "crear mi página"}
          </a>
          <Link href="/" className="lp-glass rounded-full px-6 py-3 text-sm text-white [--ink:255_255_255]">
            ir al inicio
          </Link>
        </div>
      </main>
    </div>
  );
}
