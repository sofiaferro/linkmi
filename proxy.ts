import { NextResponse, type NextRequest } from "next/server";

/**
 * Strict CSP for the editor, the only page that holds an edit session. A per-request nonce means the page
 * renders dynamically, which is why public pages (cached) are left out. Report-only until reports at
 * /api/csp-report come back clean; then rename the response header to Content-Security-Policy.
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const dev = process.env.NODE_ENV === "development";
  const policy = [
    "default-src 'self'",
    // React needs eval only for dev error overlays.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    // Inline style attributes everywhere (preview, swatches); styles cannot run code.
    "style-src 'self' 'unsafe-inline'",
    // Avatars can live on any https host.
    "img-src 'self' https: data: blob:",
    "font-src 'self'",
    // Avatar uploads go straight to Vercel Blob; dev needs the HMR websocket.
    `connect-src 'self' https://vercel.com${dev ? " ws:" : ""}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "report-uri /api/csp-report",
  ].join("; ");

  // Next reads the nonce from the request's CSP header and stamps it on its own scripts.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("content-security-policy-report-only", policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy-Report-Only", policy);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/editor",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
