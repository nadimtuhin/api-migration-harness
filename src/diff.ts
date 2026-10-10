import type { DiffItem, DiffKind, DiffOptions, DiffResult, DiffSummary } from "./types.ts";

function getType(val: unknown): string {
  if (val === null) return "null";
  if (val === undefined) return "undefined";
  if (Array.isArray(val)) return "array";
  return typeof val;
}

function matchesPattern(path: string, pattern: string): boolean {
  if (path === pattern) return true;
  // If pattern is a single key name (no dots/brackets/wildcards), match as leaf key
  if (!pattern.includes(".") && !pattern.includes("[") && !pattern.includes("*")) {
    const lastPart = path.split(".").pop()?.replace(/\[\d+\]$/, "") ?? "";
    if (lastPart === pattern) return true;
  }
  // Escape regex special chars except *
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\/]/g, "\\$&")
    .replace(/\*/g, ".*");
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(path);
}

function isPathIgnored(path: string, ignorePatterns?: string[]): boolean {
  if (!ignorePatterns || ignorePatterns.length === 0) return false;
  return ignorePatterns.some((pattern) => matchesPattern(path, pattern));
}

function diffInternal(
  legacy: unknown,
  modern: unknown,
  currentPath: string,
  options: DiffOptions,
  items: DiffItem[]
): void {
  if (currentPath && isPathIgnored(currentPath, options.ignorePaths)) {
    return;
  }

  const legacyType = getType(legacy);
  const modernType = getType(modern);

  if (legacyType !== modernType) {
    items.push({
      kind: "TYPE_MISMATCH",
      path: currentPath || "$",
      legacyValue: legacy,
      modernValue: modern,
      message: `Type mismatch: expected ${legacyType}, got ${modernType}`,
    });
    return;
  }

  if (legacyType === "null" || legacyType === "undefined") {
    return;
  }

  if (legacyType === "number") {
    const numLegacy = legacy as number;
    const numModern = modern as number;
    const tol = options.numericTolerance ?? 0;
    if (Math.abs(numLegacy - numModern) > tol) {
      items.push({
        kind: "VALUE_MISMATCH",
        path: currentPath || "$",
        legacyValue: numLegacy,
        modernValue: numModern,
        message: `Numeric difference: ${numLegacy} vs ${numModern}`,
      });
    }
    return;
  }

  if (legacyType !== "object" && legacyType !== "array") {
    if (legacy !== modern) {
      items.push({
        kind: "VALUE_MISMATCH",
        path: currentPath || "$",
        legacyValue: legacy,
        modernValue: modern,
        message: `Value mismatch: "${String(legacy)}" vs "${String(modern)}"`,
      });
    }
    return;
  }

  if (legacyType === "array") {
    const arrLegacy = legacy as unknown[];
    const arrModern = modern as unknown[];

    if (arrLegacy.length !== arrModern.length) {
      items.push({
        kind: "ARRAY_LENGTH",
        path: currentPath || "$",
        legacyValue: arrLegacy.length,
        modernValue: arrModern.length,
        message: `Array length mismatch: legacy has ${arrLegacy.length} items, modern has ${arrModern.length}`,
      });
    }

    const maxLen = Math.max(arrLegacy.length, arrModern.length);
    for (let i = 0; i < maxLen; i++) {
      const itemPath = currentPath ? `${currentPath}[${i}]` : `$[${i}]`;
      if (isPathIgnored(itemPath, options.ignorePaths)) continue;

      if (i >= arrLegacy.length) {
        items.push({
          kind: "UNEXPECTED_KEY",
          path: itemPath,
          modernValue: arrModern[i],
          message: `Unexpected extra array item at index ${i}`,
        });
      } else if (i >= arrModern.length) {
        items.push({
          kind: "MISSING_KEY",
          path: itemPath,
          legacyValue: arrLegacy[i],
          message: `Missing array item at index ${i}`,
        });
      } else {
        diffInternal(arrLegacy[i], arrModern[i], itemPath, options, items);
      }
    }
    return;
  }

  // Objects
  const objLegacy = legacy as Record<string, unknown>;
  const objModern = modern as Record<string, unknown>;
  const legacyKeys = Object.keys(objLegacy);
  const modernKeys = Object.keys(objModern);

  for (const key of legacyKeys) {
    const keyPath = currentPath ? `${currentPath}.${key}` : key;
    if (isPathIgnored(keyPath, options.ignorePaths)) continue;

    if (!(key in objModern)) {
      items.push({
        kind: "MISSING_KEY",
        path: keyPath,
        legacyValue: objLegacy[key],
        message: `Key "${key}" present in legacy but missing in modern`,
      });
    } else {
      diffInternal(objLegacy[key], objModern[key], keyPath, options, items);
    }
  }

  for (const key of modernKeys) {
    const keyPath = currentPath ? `${currentPath}.${key}` : key;
    if (isPathIgnored(keyPath, options.ignorePaths)) continue;

    if (!(key in objLegacy)) {
      items.push({
        kind: "UNEXPECTED_KEY",
        path: keyPath,
        modernValue: objModern[key],
        message: `Key "${key}" present in modern but unexpected in legacy`,
      });
    }
  }
}

export function diffJson(
  legacy: unknown,
  modern: unknown,
  options: DiffOptions = {}
): DiffResult {
  const differences: DiffItem[] = [];
  diffInternal(legacy, modern, "", options, differences);

  const summary: DiffSummary = {
    total: differences.length,
    missingKeys: 0,
    unexpectedKeys: 0,
    typeMismatches: 0,
    valueMismatches: 0,
    arrayLengthMismatches: 0,
  };

  for (const d of differences) {
    switch (d.kind) {
      case "MISSING_KEY":
        summary.missingKeys++;
        break;
      case "UNEXPECTED_KEY":
        summary.unexpectedKeys++;
        break;
      case "TYPE_MISMATCH":
        summary.typeMismatches++;
        break;
      case "VALUE_MISMATCH":
        summary.valueMismatches++;
        break;
      case "ARRAY_LENGTH":
        summary.arrayLengthMismatches++;
        break;
    }
  }

  return {
    identical: differences.length === 0,
    differences,
    summary,
  };
}

export function formatDiffReport(result: DiffResult): string {
  if (result.identical) {
    return "✓ No payload differences detected (100% parity)";
  }

  const lines: string[] = [
    `✗ Found ${result.summary.total} difference(s):`,
    `  • Missing in modern:    ${result.summary.missingKeys}`,
    `  • Unexpected in modern: ${result.summary.unexpectedKeys}`,
    `  • Type mismatches:      ${result.summary.typeMismatches}`,
    `  • Value mismatches:     ${result.summary.valueMismatches}`,
    `  • Array length diffs:   ${result.summary.arrayLengthMismatches}`,
    "",
    "Details:",
  ];

  for (const diff of result.differences) {
    lines.push(`  [${diff.kind}] at ${diff.path}`);
    if (diff.legacyValue !== undefined) {
      lines.push(`    - legacy: ${JSON.stringify(diff.legacyValue)}`);
    }
    if (diff.modernValue !== undefined) {
      lines.push(`    + modern: ${JSON.stringify(diff.modernValue)}`);
    }
    lines.push(`    Note: ${diff.message}`);
  }

  return lines.join("\n");
}
