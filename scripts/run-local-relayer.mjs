import http from "node:http";

import {
  createBlockstepRelayer,
  createHemiRelayerService,
} from "../worker/blockstepRelayer.js";

const HOST = "127.0.0.1";
const PORT = Number(process.env.BLOCKSTEP_RELAYER_PORT || 8787);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) {
  throw new Error("BLOCKSTEP_RELAYER_PORT must be an integer from 1024 through 65535.");
}

const allowedOrigins = String(process.env.ALLOWED_ORIGINS || "http://127.0.0.1:4173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const handle = createBlockstepRelayer({
  service: createHemiRelayerService(process.env),
  allowedOrigins,
});

function requestUrl(request) {
  const path = request.url?.startsWith("/") ? request.url : "/";
  return `http://${HOST}:${PORT}${path}`;
}

async function requestBody(request) {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

const server = http.createServer(async (incoming, outgoing) => {
  try {
    const body = await requestBody(incoming);
    const request = new Request(requestUrl(incoming), {
      method: incoming.method,
      headers: incoming.headers,
      body: body?.length ? body : undefined,
    });
    const response = await handle(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    outgoing.writeHead(500, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    outgoing.end(JSON.stringify({
      error: { code: "LOCAL_RELAYER_ERROR", message: "The local verification service failed safely." },
    }));
  }
});

server.listen(PORT, HOST, () => {
  const mode = process.env.RELAYER_PRIVATE_KEY ? "signed submission enabled" : "read-only challenge mode";
  console.log(`BLOCKSTEP local relayer: http://${HOST}:${PORT} (${mode})`);
  console.log("Routes: GET /api/challenge, POST /api/verify");
});

function close() {
  server.close(() => process.exit(0));
}

process.once("SIGINT", close);
process.once("SIGTERM", close);

