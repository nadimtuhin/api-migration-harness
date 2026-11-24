import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { executeEndpoint } from "../src/runner.ts";
import { testIdempotency } from "../src/idempotency.ts";

describe("regressions", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  let counter = 0;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/echo-headers") {
          return Response.json({
            contentType: req.headers.get("content-type"),
            accept: req.headers.get("accept"),
          });
        }
        if (url.pathname === "/cookie") {
          return new Response(JSON.stringify({ ok: true }), {
            headers: {
              "content-type": "application/json",
              "set-cookie": "session=super-secret-token; HttpOnly",
              "x-request-id": "req-1",
            },
          });
        }
        if (url.pathname === "/same-id-new-timestamp") {
          counter++;
          return Response.json({ id: "deal_1", paid_at: `2026-01-0${counter}T00:00:00Z` });
        }
        return new Response("not found", { status: 404 });
      },
    });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  it("does not duplicate Content-Type/Accept when caller passes lowercase header names", async () => {
    const res = await executeEndpoint(`${baseUrl}/echo-headers`, {
      method: "POST",
      headers: { "content-type": "application/vnd.api+json", accept: "application/json" },
      body: { a: 1 },
    });
    const body = res.body as { contentType: string; accept: string };
    expect(body.contentType).toBe("application/vnd.api+json");
    expect(body.accept).toBe("application/json");
  });

  it("redacts Set-Cookie response headers from captured responses", async () => {
    const res = await executeEndpoint(`${baseUrl}/cookie`);
    expect(res.headers["set-cookie"]).toBe("[REDACTED]");
    expect(res.headers["x-request-id"]).toBe("req-1");
    expect(JSON.stringify(res)).not.toContain("super-secret-token");
  });

  it("does not flag a double write when only a field containing 'id' as a substring differs", async () => {
    counter = 0;
    const result = await testIdempotency({
      url: `${baseUrl}/same-id-new-timestamp`,
      repeatCount: 1,
    });
    expect(result.bodyConsistent).toBe(false);
    expect(result.doubleWriteDetected).toBe(false);
    expect(result.details).toContain("BODY INCONSISTENCY");
  });
});
