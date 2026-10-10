import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createMockServer } from "../mock/server.ts";
import { formatIdempotencyReport, testIdempotency } from "../src/idempotency.ts";

describe("testIdempotency", () => {
  let mock: ReturnType<typeof createMockServer>;
  let baseUrl: string;

  beforeAll(() => {
    mock = createMockServer(0);
    baseUrl = mock.url;
  });

  afterAll(() => {
    mock.close();
  });

  it("verifies modern v2 endpoint is idempotent across duplicate requests", async () => {
    mock.reset();
    const payload = {
      name: "Acme Renewal Deal",
      amount: 45000,
      currency: "USD",
      status: "won",
    };

    const result = await testIdempotency({
      url: `${baseUrl}/v2/deals`,
      method: "POST",
      body: payload,
      repeatCount: 2,
      probeUrl: `${baseUrl}/v2/deals`,
    });

    expect(result.passed).toBe(true);
    expect(result.doubleWriteDetected).toBe(false);
    expect(result.statusConsistent).toBe(true);
    expect(result.bodyConsistent).toBe(true);
    expect(result.runs).toHaveLength(3); // 1 initial + 2 repeats
    expect(result.runs[1].cacheHit).toBe(true);
    expect(result.runs[2].cacheHit).toBe(true);
    expect(result.probeResults?.countDifference).toBe(1); // Exactly 1 item created overall
  });

  it("detects double-write vulnerability in legacy v1 endpoint", async () => {
    mock.reset();
    const payload = {
      name: "Legacy Non-Idempotent Deal",
      amount_cents: 200000,
      currency: "USD",
      status: "OPEN",
    };

    const result = await testIdempotency({
      url: `${baseUrl}/v1/deals`,
      method: "POST",
      body: payload,
      repeatCount: 2,
      probeUrl: `${baseUrl}/v1/deals`,
    });

    expect(result.passed).toBe(false);
    expect(result.doubleWriteDetected).toBe(true);
    // Legacy added a new record on each retry!
    expect(result.probeResults?.countDifference).toBe(3);
    expect(result.details).toContain("DOUBLE-WRITE DETECTED");
  });

  it("formats idempotency report clearly", async () => {
    mock.reset();
    const result = await testIdempotency({
      url: `${baseUrl}/v2/deals`,
      method: "POST",
      body: { name: "Reporting Deal" },
      repeatCount: 1,
      probeUrl: `${baseUrl}/v2/deals`,
    });

    const report = formatIdempotencyReport(result);
    expect(report).toContain("IDEMPOTENCY TEST: PASSED");
    expect(report).toContain("IDEMPOTENT");
    expect(report).toContain("Probe Count:");
  });
});
