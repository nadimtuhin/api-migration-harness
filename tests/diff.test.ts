import { describe, expect, it } from "bun:test";
import { diffJson, formatDiffReport } from "../src/diff.ts";

describe("diffJson", () => {
  it("reports identical when objects have exact same keys and values", () => {
    const a = { id: 1, name: "Deal A", items: ["X", "Y"] };
    const b = { id: 1, name: "Deal A", items: ["X", "Y"] };

    const result = diffJson(a, b);
    expect(result.identical).toBe(true);
    expect(result.differences).toHaveLength(0);
    expect(result.summary.total).toBe(0);
  });

  it("detects missing keys in modern response", () => {
    const legacy = { id: 10, name: "Deal", legacy_field: "old" };
    const modern = { id: 10, name: "Deal" };

    const result = diffJson(legacy, modern);
    expect(result.identical).toBe(false);
    expect(result.summary.missingKeys).toBe(1);
    expect(result.differences[0].kind).toBe("MISSING_KEY");
    expect(result.differences[0].path).toBe("legacy_field");
  });

  it("detects unexpected keys in modern response", () => {
    const legacy = { id: 10, name: "Deal" };
    const modern = { id: 10, name: "Deal", modern_extra: "new" };

    const result = diffJson(legacy, modern);
    expect(result.identical).toBe(false);
    expect(result.summary.unexpectedKeys).toBe(1);
    expect(result.differences[0].kind).toBe("UNEXPECTED_KEY");
    expect(result.differences[0].path).toBe("modern_extra");
  });

  it("detects type mismatches", () => {
    const legacy = { amount: 5000 };
    const modern = { amount: "5000" };

    const result = diffJson(legacy, modern);
    expect(result.identical).toBe(false);
    expect(result.summary.typeMismatches).toBe(1);
    expect(result.differences[0].kind).toBe("TYPE_MISMATCH");
    expect(result.differences[0].path).toBe("amount");
  });

  it("detects primitive value differences", () => {
    const legacy = { status: "OPEN" };
    const modern = { status: "open" };

    const result = diffJson(legacy, modern);
    expect(result.identical).toBe(false);
    expect(result.summary.valueMismatches).toBe(1);
    expect(result.differences[0].kind).toBe("VALUE_MISMATCH");
    expect(result.differences[0].legacyValue).toBe("OPEN");
    expect(result.differences[0].modernValue).toBe("open");
  });

  it("detects array length differences and item discrepancies", () => {
    const legacy = { items: [1, 2, 3] };
    const modern = { items: [1, 2] };

    const result = diffJson(legacy, modern);
    expect(result.identical).toBe(false);
    expect(result.summary.arrayLengthMismatches).toBe(1);
    expect(result.summary.missingKeys).toBe(1); // missing items[2]
  });

  it("respects ignorePaths patterns", () => {
    const legacy = {
      id: "abc-1",
      timestamp: 1600000000,
      user: { id: "u-1", name: "Alice", created_at: "2026-01-01" },
    };
    const modern = {
      id: "abc-2",
      timestamp: 1700000000,
      user: { id: "u-2", name: "Alice", created_at: "2026-10-10" },
    };

    // Ignore exact path and wildcard patterns
    const result = diffJson(legacy, modern, {
      ignorePaths: ["id", "timestamp", "*.created_at"],
    });

    expect(result.identical).toBe(true);
    expect(result.differences).toHaveLength(0);
  });

  it("respects numericTolerance option", () => {
    const legacy = { score: 10.001 };
    const modern = { score: 10.002 };

    const strict = diffJson(legacy, modern);
    expect(strict.identical).toBe(false);

    const tolerant = diffJson(legacy, modern, { numericTolerance: 0.01 });
    expect(tolerant.identical).toBe(true);
  });

  it("formats a human-readable diff report", () => {
    const legacy = { name: "Test", code: 1 };
    const modern = { name: "Test", code: 2 };

    const result = diffJson(legacy, modern);
    const text = formatDiffReport(result);
    expect(text).toContain("Found 1 difference(s)");
    expect(text).toContain("VALUE_MISMATCH");
    expect(text).toContain("code");
  });
});
