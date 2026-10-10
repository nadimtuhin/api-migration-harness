import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createMockServer } from "../mock/server.ts";
import { dualRun, executeEndpoint, formatDualRunReport } from "../src/runner.ts";

describe("runner & dualRun", () => {
  let mock: ReturnType<typeof createMockServer>;
  let baseUrl: string;

  beforeAll(() => {
    mock = createMockServer(0); // ephemeral port
    baseUrl = mock.url;
  });

  afterAll(() => {
    mock.close();
  });

  it("executes an endpoint and captures response details and latency", async () => {
    const res = await executeEndpoint(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(res.isJson).toBe(true);
    expect((res.body as { status: string }).status).toBe("ok");
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("dual-runs matching endpoints and confirms parity", async () => {
    const result = await dualRun({
      legacyUrl: `${baseUrl}/v1/parity/deals`,
      modernUrl: `${baseUrl}/v2/parity/deals`,
      method: "GET",
    });

    expect(result.parity).toBe(true);
    expect(result.statusMatch).toBe(true);
    expect(result.legacy.status).toBe(200);
    expect(result.modern.status).toBe(200);
    expect(result.diff.identical).toBe(true);
  });

  it("dual-runs POST requests with body and confirms parity", async () => {
    const payload = { test: true, dealName: "Migration Test" };
    const result = await dualRun({
      legacyUrl: `${baseUrl}/v1/parity/deal`,
      modernUrl: `${baseUrl}/v2/parity/deal`,
      method: "POST",
      body: payload,
    });

    expect(result.parity).toBe(true);
    expect(result.legacy.status).toBe(200);
    expect(result.modern.status).toBe(200);
  });

  it("detects drift between legacy v1 and modern v2 CRM schemas", async () => {
    const result = await dualRun({
      legacyUrl: `${baseUrl}/v1/deals`,
      modernUrl: `${baseUrl}/v2/deals`,
      method: "GET",
    });

    expect(result.parity).toBe(false);
    expect(result.statusMatch).toBe(true); // Both return 200
    expect(result.diff.identical).toBe(false);

    // v1 has deal_id, amount_cents, line_items; v2 has id, amount, lineItems
    const diffPaths = result.diff.differences.map((d) => d.path);
    expect(diffPaths.some((p) => p.includes("deal_id") || p.includes("amount_cents"))).toBe(true);
    expect(diffPaths.some((p) => p.includes("id") || p.includes("amount"))).toBe(true);
  });

  it("handles network failure gracefully", async () => {
    const result = await dualRun({
      legacyUrl: `${baseUrl}/health`,
      modernUrl: "http://127.0.0.1:59999/unreachable",
      method: "GET",
      timeoutMs: 500,
    });

    expect(result.parity).toBe(false);
    expect(result.statusMatch).toBe(false);
    expect(result.modern.error).toBeDefined();
    expect(result.modern.status).toBe(0);
  });

  it("formats dual run report nicely", async () => {
    const result = await dualRun({
      legacyUrl: `${baseUrl}/v1/parity/deals`,
      modernUrl: `${baseUrl}/v2/parity/deals`,
    });

    const report = formatDualRunReport(result);
    expect(report).toContain("DUAL-RUN PARITY REPORT: PASSED");
    expect(report).toContain("PARITY VERIFIED");
  });
});
