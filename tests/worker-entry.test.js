import assert from "node:assert/strict";
import test from "node:test";

import worker from "../worker/index.js";

test("the Worker serves static assets with release security headers", async () => {
  let assetRequests = 0;
  const response = await worker.fetch(new Request("https://blockstep.example/"), {
    ASSETS: {
      async fetch(request) {
        assetRequests += 1;
        assert.equal(new URL(request.url).pathname, "/");
        return new Response("<!doctype html><title>BLOCKSTEP</title>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    },
  });

  assert.equal(assetRequests, 1);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /BLOCKSTEP/);
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
});

test("API paths never fall through to the static asset binding", async () => {
  let assetRequests = 0;
  const response = await worker.fetch(new Request("https://blockstep.example/api/unknown"), {
    ASSETS: { async fetch() { assetRequests += 1; return new Response("asset"); } },
  });
  const body = await response.json();

  assert.equal(assetRequests, 0);
  assert.equal(response.status, 404);
  assert.equal(body.error.code, "NOT_FOUND");
});
