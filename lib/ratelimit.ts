import "server-only";
import { Ratelimit } from "@upstash/ratelimit";
import { redis } from "./store";

/** Per-IP limits; null when the deploy has no Redis (those features are off there anyway). */
export const limiters = redis
  ? {
      publish: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5, "1 h"), prefix: "rl:publish" }),
      save: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(60, "1 h"), prefix: "rl:save" }),
      upload: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, "1 h"), prefix: "rl:upload" }),
      import: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(20, "1 h"), prefix: "rl:import" }),
      // Opening edit links, passkey sign-ins and passkey changes.
      auth: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(30, "1 h"), prefix: "rl:auth" }),
      // WebAuthn options, fetched ahead of the click; each only stores a 5-minute challenge.
      challenge: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(120, "1 h"), prefix: "rl:challenge" }),
      report: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(60, "1 h"), prefix: "rl:report" }),
    }
  : null;

/** Vercel sets x-real-ip itself, so clients cannot spoof it. */
export const clientIp = (h: Headers) =>
  h.get("x-real-ip") ?? h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "anon";

/** True when the request may proceed; always true without Redis. */
export async function allow(kind: keyof NonNullable<typeof limiters>, h: Headers) {
  return limiters ? (await limiters[kind].limit(clientIp(h))).success : true;
}
