import { diffJson } from "./diff.ts";
import type { DualRunConfig, DualRunResult, EndpointResponse } from "./types.ts";

export async function executeEndpoint(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    timeoutMs?: number;
  } = {}
): Promise<EndpointResponse> {
  const method = (options.method ?? "GET").toUpperCase();
  const timeoutMs = options.timeoutMs ?? 10000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const reqHeaders: Record<string, string> = {
    Accept: "application/json, text/plain, */*",
    ...options.headers,
  };

  let reqBody: string | undefined = undefined;
  if (options.body !== undefined && options.body !== null) {
    if (typeof options.body === "string") {
      reqBody = options.body;
    } else {
      reqBody = JSON.stringify(options.body);
      if (!reqHeaders["Content-Type"]) {
        reqHeaders["Content-Type"] = "application/json";
      }
    }
  }

  const start = performance.now();
  try {
    const res = await fetch(url, {
      method,
      headers: reqHeaders,
      body: reqBody,
      signal: controller.signal,
    });
    const durationMs = Math.round((performance.now() - start) * 100) / 100;

    const respHeaders: Record<string, string> = {};
    res.headers.forEach((value: string, key: string) => {
      respHeaders[key.toLowerCase()] = value;
    });

    const rawText = await res.text();
    let body: unknown = rawText;
    let isJson = false;

    if (rawText.trim().length > 0) {
      try {
        body = JSON.parse(rawText);
        isJson = true;
      } catch {
        // Leave body as rawText
        isJson = false;
      }
    } else {
      body = null;
      isJson = true;
    }

    return {
      url,
      status: res.status,
      statusText: res.statusText,
      headers: respHeaders,
      durationMs,
      body,
      rawText,
      isJson,
    };
  } catch (err: unknown) {
    const durationMs = Math.round((performance.now() - start) * 100) / 100;
    const msg = err instanceof Error ? err.message : String(err);
    return {
      url,
      status: 0,
      statusText: "NETWORK_ERROR",
      headers: {},
      durationMs,
      body: null,
      rawText: "",
      isJson: false,
      error: msg,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function dualRun(config: DualRunConfig): Promise<DualRunResult> {
  const reqOptions = {
    method: config.method,
    headers: config.headers,
    body: config.body,
    timeoutMs: config.timeoutMs,
  };

  // Run both requests in parallel
  const [legacyRes, modernRes] = await Promise.all([
    executeEndpoint(config.legacyUrl, reqOptions),
    executeEndpoint(config.modernUrl, reqOptions),
  ]);

  const statusMatch = legacyRes.status === modernRes.status;

  const diff = diffJson(legacyRes.body, modernRes.body, {
    ignorePaths: config.ignorePaths,
  });

  const durationDeltaMs = Math.round((modernRes.durationMs - legacyRes.durationMs) * 100) / 100;
  const parity = statusMatch && diff.identical && !legacyRes.error && !modernRes.error;

  return {
    parity,
    statusMatch,
    diff,
    legacy: legacyRes,
    modern: modernRes,
    durationDeltaMs,
  };
}

export function formatDualRunReport(result: DualRunResult): string {
  const lines: string[] = [];

  const statusIcon = result.statusMatch ? "✓" : "✗";
  const parityIcon = result.parity ? "✓" : "✗";

  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(` DUAL-RUN PARITY REPORT: ${result.parity ? "PASSED" : "FAILED"}`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(`Overall Parity:     ${parityIcon} ${result.parity ? "PARITY VERIFIED" : "DRIFT DETECTED"}`);
  lines.push(`HTTP Status:        ${statusIcon} Legacy ${result.legacy.status} vs Modern ${result.modern.status}`);
  lines.push(`Latency (Legacy):   ${result.legacy.durationMs}ms`);
  lines.push(`Latency (Modern):   ${result.modern.durationMs}ms (${result.durationDeltaMs >= 0 ? "+" : ""}${result.durationDeltaMs}ms)`);

  if (result.legacy.error) {
    lines.push(`Legacy Error:       ${result.legacy.error}`);
  }
  if (result.modern.error) {
    lines.push(`Modern Error:       ${result.modern.error}`);
  }

  lines.push("");
  lines.push("--- Response Diff ---");
  if (result.diff.identical) {
    lines.push("✓ Responses are identical.");
  } else {
    lines.push(`✗ Found ${result.diff.summary.total} difference(s):`);
    for (const d of result.diff.differences) {
      lines.push(`  • [${d.kind}] ${d.path}`);
      if (d.legacyValue !== undefined) lines.push(`    - Legacy: ${JSON.stringify(d.legacyValue)}`);
      if (d.modernValue !== undefined) lines.push(`    + Modern: ${JSON.stringify(d.modernValue)}`);
    }
  }

  return lines.join("\n");
}
