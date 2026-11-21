import { allow } from "@/lib/ratelimit";

/** Collects the editor's CSP violation reports (see proxy.ts) into the function logs. */
export async function POST(request: Request) {
  if (await allow("report", request.headers)) {
    console.warn("csp-report", (await request.text()).slice(0, 4000));
  }
  return new Response(null, { status: 204 });
}
