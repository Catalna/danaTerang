import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";

import { createApp } from "../src/app.js";

test("health route reports the API service", async () => {
  const response = await request(createApp()).get("/api/health");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: "ok", service: "dana-terang-api" });
});

test("wallet unbinding passes browser CORS preflight only for the configured origin", async () => {
  const app = createApp({ webOrigin: "http://localhost:3000" });
  const response = await request(app).options("/api/verifier/wallet")
    .set("Origin", "http://localhost:3000")
    .set("Access-Control-Request-Method", "DELETE");
  assert.equal(response.status, 204);
  assert.equal(response.headers["access-control-allow-origin"], "http://localhost:3000");
  assert.ok(response.headers["access-control-allow-methods"].split(",").includes("DELETE"));
  const denied = await request(app).options("/api/verifier/wallet")
    .set("Origin", "http://unrelated.example")
    .set("Access-Control-Request-Method", "DELETE");
  assert.equal(denied.headers["access-control-allow-origin"], undefined);
});

test("malformed JSON returns a generic client error", async () => {
  const response = await request(createApp())
    .post("/api/unknown")
    .set("content-type", "application/json")
    .send("{");

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { error: "invalid_json" });
  assert.equal(JSON.stringify(response.body).includes("SyntaxError"), false);
});

test("oversized JSON returns 413 without echoing the body", async () => {
  const payload = JSON.stringify({ value: "x".repeat(1_048_600) });
  const response = await request(createApp())
    .post("/api/unknown")
    .set("content-type", "application/json")
    .send(payload);

  assert.equal(response.status, 413);
  assert.deepEqual(response.body, { error: "request_too_large" });
});
