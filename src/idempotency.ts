import { diffJson } from "./diff.ts";
import { executeEndpoint } from "./runner.ts";
import type {
  DiffItem,
  IdempotencyConfig,
  IdempotencyResult,
  IdempotencyRun,
} from "./types.ts";

async function probeItemCount(url: string, headers?: Record<string, string>): Promise<number | undefined> {
  try {
    const res = await executeEndpoint(url, { method: "GET", headers });
    if (res.status >= 200 && res.status < 300 && res.body) {
      if (Array.isArray(res.body)) {
        return res.body.length;
      }
      if (typeof res.body === "object" && res.body !== null) {
        const obj = res.body as Record<string, unknown>;
        if (typeof obj.count === "number") return obj.count;
        if (typeof obj.total === "number") return obj.total;
        if (Array.isArray(obj.items)) return obj.items.length;
        if (Array.isArray(obj.deals)) return obj.deals.length;
        if (Array.isArray(obj.data)) return obj.data.length;
      }
    }
  } catch {
    // Probe failed or unparseable, return undefined
  }
  return undefined;
}

export async function testIdempotency(
  config: IdempotencyConfig
): Promise<IdempotencyResult> {
  const method = (config.method ?? "POST").toUpperCase();
  const keyHeader = config.keyHeader ?? "Idempotency-Key";
  const idempotencyKey = config.key ?? crypto.randomUUID();
  const repeatCount = Math.max(1, config.repeatCount ?? 2);

  let initialProbeCount: number | undefined = undefined;
  if (config.probeUrl) {
    initialProbeCount = await probeItemCount(config.probeUrl, config.headers);
  }

  const runs: IdempotencyRun[] = [];
  const totalAttempts = 1 + repeatCount;
  const allDifferences: DiffItem[] = [];

  for (let i = 1; i <= totalAttempts; i++) {
    const reqHeaders: Record<string, string> = {
      ...config.headers,
      [keyHeader]: idempotencyKey,
    };

    const res = await executeEndpoint(config.url, {
      method,
      headers: reqHeaders,
      body: config.body,
      timeoutMs: config.timeoutMs,
    });

    const isCacheHit =
      res.headers["x-cache"]?.toUpperCase().includes("IDEMPOTENT") ||
      res.headers["idempotency-replayed"] === "true" ||
      false;

    runs.push({
      attempt: i,
      status: res.status,
      durationMs: res.durationMs,
      headers: res.headers,
      body: res.body,
      rawText: res.rawText,
      cacheHit: isCacheHit,
    });

    // Diff against initial response
    if (i > 1) {
      const diff = diffJson(runs[0].body, res.body, {
        ignorePaths: config.ignorePaths,
      });
      if (!diff.identical) {
        allDifferences.push(...diff.differences);
      }
    }
  }

  // Verification checks:
  // 1. Status consistency: all runs should return expected status (e.g. 200 or 201)
  const initialStatus = runs[0].status;
  const statusConsistent = runs.every((r) => r.status === initialStatus);

  // 2. Body consistency: responses across identical requests should match
  const bodyConsistent = allDifferences.length === 0;

  // 3. Double write detection via probeUrl
  let doubleWriteDetected = false;
  let finalProbeCount: number | undefined = undefined;
  let countDifference: number | undefined = undefined;

  if (config.probeUrl) {
    finalProbeCount = await probeItemCount(config.probeUrl, config.headers);
    if (initialProbeCount !== undefined && finalProbeCount !== undefined) {
      countDifference = finalProbeCount - initialProbeCount;
      // In an idempotent write, total new records added across all attempts must be <= 1
      if (countDifference > 1) {
        doubleWriteDetected = true;
      }
    }
  }

  // If bodies differ significantly with new IDs created on each attempt without probeUrl:
  // e.g. if the initial body has a different ID or record count from second run
  if (
    !doubleWriteDetected &&
    allDifferences.some(
      (d) =>
        (d.path.includes("id") || d.path.includes("deal_id") || d.path.includes("_id")) &&
        d.kind === "VALUE_MISMATCH"
    )
  ) {
    doubleWriteDetected = true;
  }

  const passed =
    statusConsistent &&
    bodyConsistent &&
    !doubleWriteDetected &&
    initialStatus >= 200 &&
    initialStatus < 300;

  let details = "";
  if (passed) {
    details = `Endpoint successfully honored Idempotency-Key across ${totalAttempts} requests. No duplicate records created.`;
  } else if (doubleWriteDetected) {
    details = `DOUBLE-WRITE DETECTED: Duplicate requests with Idempotency-Key "${idempotencyKey}" created distinct records.`;
  } else if (!statusConsistent) {
    details = `STATUS INCONSISTENCY: Subsequent requests returned different HTTP statuses (${runs.map((r) => r.status).join(", ")}).`;
  } else if (!bodyConsistent) {
    details = `BODY INCONSISTENCY: Duplicate requests returned divergent payloads (${allDifferences.length} difference(s)).`;
  } else {
    details = `FAILED: Initial request returned HTTP ${initialStatus}.`;
  }

  return {
    passed,
    idempotencyKey,
    statusConsistent,
    bodyConsistent,
    doubleWriteDetected,
    runs,
    differences: allDifferences,
    probeResults:
      initialProbeCount !== undefined || finalProbeCount !== undefined
        ? {
            initialCount: initialProbeCount,
            finalCount: finalProbeCount,
            countDifference,
          }
        : undefined,
    details,
  };
}

export function formatIdempotencyReport(result: IdempotencyResult): string {
  const lines: string[] = [];
  const statusIcon = result.passed ? "✓" : "✗";

  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(` IDEMPOTENCY TEST: ${result.passed ? "PASSED" : "FAILED"}`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(`Status:              ${statusIcon} ${result.passed ? "IDEMPOTENT" : "NON-IDEMPOTENT"}`);
  lines.push(`Idempotency-Key:     ${result.idempotencyKey}`);
  lines.push(`Total Invocations:   ${result.runs.length}`);
  lines.push(`Status Consistency:  ${result.statusConsistent ? "✓" : "✗"} (${result.runs.map((r) => r.status).join(" -> ")})`);
  lines.push(`Body Consistency:    ${result.bodyConsistent ? "✓" : "✗"}`);
  lines.push(`Double Write:        ${result.doubleWriteDetected ? "✗ DETECTED" : "✓ None detected"}`);

  if (result.probeResults) {
    lines.push(`Probe Count:         Before: ${result.probeResults.initialCount} -> After: ${result.probeResults.finalCount} (delta: +${result.probeResults.countDifference})`);
  }

  lines.push("");
  lines.push("Attempts Breakdown:");
  for (const run of result.runs) {
    const hitLabel = run.cacheHit ? " [CACHE HIT]" : "";
    lines.push(`  Attempt #${run.attempt}: HTTP ${run.status} in ${run.durationMs}ms${hitLabel}`);
  }

  if (result.differences.length > 0) {
    lines.push("");
    lines.push(`Differences across retries (${result.differences.length}):`);
    for (const d of result.differences) {
      lines.push(`  • [${d.kind}] ${d.path}: legacy=${JSON.stringify(d.legacyValue)} modern=${JSON.stringify(d.modernValue)}`);
    }
  }

  lines.push("");
  lines.push(`Result: ${result.details}`);

  return lines.join("\n");
}
