import {
  createBlockstepRelayer,
  createHemiRelayerService,
  createInMemoryRateLimiter,
} from "./blockstepRelayer.js";

const rateLimiter = createInMemoryRateLimiter();

const SECURITY_HEADERS = Object.freeze({
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' blob: data:",
    "connect-src 'self' https://rpc.hemi.network",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join("; "),
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});

async function staticResponse(request, env) {
  if (!env.ASSETS?.fetch) return new Response("Not Found", { status: 404 });
  const response = await env.ASSETS.fetch(request);
  const secured = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) secured.headers.set(name, value);
  return secured;
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith("/api/")) return staticResponse(request, env);
    const allowedOrigins = String(env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean);
    const handle = createBlockstepRelayer({
      service: createHemiRelayerService(env),
      allowedOrigins,
      rateLimiter,
    });
    return handle(request);
  },
};
