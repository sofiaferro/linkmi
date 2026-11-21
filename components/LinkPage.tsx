"use client";

import ShaderCanvas from "./ShaderCanvas";
import { FONTS, sanitizeUrl, type PageConfig } from "@/lib/config";

type Props = {
  config: PageConfig;
  /** Render inside a container (editor preview) instead of filling the viewport. */
  contained?: boolean;
  footer?: boolean;
  /** When set, public pages show a discreet "reportar" mailto link. */
  reportEmail?: string;
};

export default function LinkPage({ config, contained = false, footer = true, reportEmail }: Props) {
  const font = FONTS[config.font];
  const light = config.ink === "light";
  const links = config.links
    .map((l) => ({ ...l, href: sanitizeUrl(l.url) }))
    .filter((l) => l.title.trim() && l.href);

  return (
    <div
      data-shader={config.shader}
      className={`${contained ? "absolute" : "fixed"} inset-0 overflow-hidden`}
      style={
        {
          "--ink": light ? "255 255 255" : "12 12 14",
          "--ink-inv": light ? "12 12 14" : "255 255 255",
          "--radius": `${config.radius}px`,
          color: light ? "#fff" : "#0c0c0e",
          fontFamily: font.body,
          // Shown until the shader's first frame, and instead of it without WebGL.
          background: `radial-gradient(circle at 20% 15%, ${config.colors[1]}, transparent 65%), radial-gradient(circle at 85% 90%, color-mix(in srgb, ${config.colors[2]} 35%, transparent), transparent 55%), ${config.colors[0]}`,
        } as React.CSSProperties
      }
    >
      <ShaderCanvas
        shader={config.shader}
        colors={config.colors}
        speed={config.speed}
        className="absolute inset-0 h-full w-full"
      />

      <div className="no-scrollbar absolute inset-0 overflow-y-auto">
      <main className="relative mx-auto flex min-h-full w-full max-w-[34rem] flex-col items-center px-4 pb-10 pt-16 sm:pt-24">
        {config.avatar ? (
          // eslint-disable-next-line @next/next/no-img-element -- arbitrary user URLs
          <img
            src={config.avatar}
            alt=""
            className="lp-rise h-24 w-24 rounded-full object-cover ring-1 ring-[rgb(var(--ink)/0.25)] ring-offset-4 ring-offset-transparent"
          />
        ) : null}

        <h1
          className="lp-rise mt-6 text-center text-4xl leading-none tracking-tight sm:text-5xl"
          style={{
            fontFamily: font.display,
            fontStyle: font.italic ? "italic" : "normal",
            fontWeight: config.font === "syne" ? 700 : 400,
            animationDelay: "60ms",
          }}
        >
          {config.name}
        </h1>

        {config.bio ? (
          <p
            className="lp-rise lp-label mt-3 max-w-sm text-balance text-center text-[13px] leading-relaxed text-[rgb(var(--ink)/0.7)]"
            style={{ animationDelay: "110ms" }}
          >
            {config.bio}
          </p>
        ) : null}

        <ul className={`mt-10 flex w-full flex-col ${config.button === "line" ? "gap-0" : "gap-3"}`}>
          {links.map((l, i) => (
            <li key={l.id} className="lp-rise" style={{ animationDelay: `${160 + i * 45}ms` }}>
              <a
                href={l.href}
                target="_blank"
                rel="noopener noreferrer"
                className={`lp-btn lp-${config.button} group flex min-h-14 items-center gap-4 px-5 py-3 text-[14px]`}
              >
                {config.showIndex ? (
                  <span className="w-5 shrink-0 font-mono text-[10px] tabular-nums opacity-50">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                ) : null}
                <span className="line-clamp-2 flex-1 text-balance break-words">{l.title}</span>
                <span aria-hidden className="lp-arrow shrink-0 text-[13px] opacity-50">
                  ↗
                </span>
              </a>
            </li>
          ))}
        </ul>

        {footer ? (
          <div className="mt-auto pt-16 font-mono text-[10px] uppercase tracking-[0.2em]">
            <div className="lp-label flex gap-6">
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- full page load: the editor's CSP (proxy.ts) only covers documents it serves */}
              <a href="/editor" className="opacity-40 transition-opacity hover:opacity-100">
                linkmi · creá la tuya →
              </a>
              {reportEmail ? (
                <a
                  href={`mailto:${reportEmail}?subject=${encodeURIComponent(`reporte: ${config.name}`)}`}
                  className="opacity-40 transition-opacity hover:opacity-100"
                >
                  reportar
                </a>
              ) : null}
            </div>
          </div>
        ) : null}
      </main>
      </div>
    </div>
  );
}
