import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { createMockServer } from "../mock/server.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");

async function runCliProc(args: string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const proc = Bun.spawn(["bun", cliPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

describe("CLI Process Interface (e2e)", () => {
  let mock: ReturnType<typeof createMockServer>;
  let baseUrl: string;

  beforeAll(() => {
    mock = createMockServer(0);
    baseUrl = mock.url;
  });

  afterAll(() => {
    mock.close();
  });

  it("prints help and exits 0 on --help", async () => {
    const { stdout, exitCode } = await runCliProc(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("api-migration-harness - Dual-run API migration testing");
    expect(stdout).toContain("dual-run");
    expect(stdout).toContain("diff");
    expect(stdout).toContain("idempotent");
  });

  it("prints version and exits 0 on --version", async () => {
    const { stdout, exitCode } = await runCliProc(["--version"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("0.1.0");
  });

  it("exits 2 on unknown command", async () => {
    const { stderr, exitCode } = await runCliProc(["unknown-cmd"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('Unknown command "unknown-cmd"');
  });

  it("exits 2 on missing required flag", async () => {
    const { stderr, exitCode } = await runCliProc(["dual-run", "--legacy", "http://localhost"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("Missing required flag: --modern");
  });

  it("emits JSON envelope and exits 2 when flag missing with --json", async () => {
    const { stdout, exitCode } = await runCliProc(["dual-run", "--legacy", "http://localhost", "--json"]);
    expect(exitCode).toBe(2);
    const envelope = JSON.parse(stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toContain("Missing required flag: --modern");
  });

  it("runs diff between two JSON strings (parity pass = 0)", async () => {
    const { stdout, exitCode } = await runCliProc([
      "diff",
      "--legacy",
      '{"status":"ok","code":200}',
      "--modern",
      '{"status":"ok","code":200}',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("100% parity");
  });

  it("runs diff between two JSON strings (drift fail = 1)", async () => {
    const { stdout, exitCode } = await runCliProc([
      "diff",
      "--legacy",
      '{"status":"ok","code":200}',
      "--modern",
      '{"status":"fail","code":500}',
    ]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("Found 2 difference(s)");
  });

  it("emits structured envelope with diff --json", async () => {
    const { stdout, exitCode } = await runCliProc([
      "diff",
      "--legacy",
      '{"val":1}',
      "--modern",
      '{"val":2}',
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const env = JSON.parse(stdout);
    expect(env.ok).toBe(false);
    expect(env.data.summary.valueMismatches).toBe(1);
  });

  it("dual-run against matching mock parity routes returns 0", async () => {
    const { stdout, exitCode } = await runCliProc([
      "dual-run",
      "--legacy",
      `${baseUrl}/v1/parity/deals`,
      "--modern",
      `${baseUrl}/v2/parity/deals`,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("PARITY VERIFIED");
  });

  it("dual-run against diverging mock routes returns 1", async () => {
    const { stdout, exitCode } = await runCliProc([
      "dual-run",
      "--legacy",
      `${baseUrl}/v1/deals`,
      "--modern",
      `${baseUrl}/v2/deals`,
    ]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("DRIFT DETECTED");
  });

  it("idempotency check passes on modern endpoint with exit 0", async () => {
    mock.reset();
    const { stdout, exitCode } = await runCliProc([
      "idempotent",
      "--url",
      `${baseUrl}/v2/deals`,
      "--body",
      '{"name":"CLI Idempotent Deal"}',
      "--probe",
      `${baseUrl}/v2/deals`,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("IDEMPOTENCY TEST: PASSED");
  });

  it("idempotency check fails on legacy non-idempotent endpoint with exit 1", async () => {
    mock.reset();
    const { stdout, exitCode } = await runCliProc([
      "idempotent",
      "--url",
      `${baseUrl}/v1/deals`,
      "--body",
      '{"name":"CLI Non-Idempotent Deal"}',
      "--probe",
      `${baseUrl}/v1/deals`,
    ]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("DOUBLE-WRITE DETECTED");
  });
});
