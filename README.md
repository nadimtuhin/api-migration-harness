# api-migration-harness

> Production-grade, zero-dependency CLI harness for dual-running legacy vs modern APIs, verifying payload parity, deep JSON diffing, and validating write idempotency.

Built with **Bun + TypeScript**. Zero heavy external dependencies.

---

## The Problem

Migrating critical production endpoints (e.g., monolith `v1` to modern service `v2`) is high-risk:

- **Silent Schema Drift**: Field renaming (`deal_id` to `id`), casing changes (`line_items` to `lineItems`), or dropped keys slip past manual testing.
- **Subtle Type Coercions**: Numbers coerced to strings (`5000` to `"5000"`), cents converted to floats without precision checks, or `null` vs missing keys.
- **Double Writes & Broken Idempotency**: Modern endpoints often promise idempotency via `Idempotency-Key`, but retries, network glitches, or race conditions lead to duplicated database records.
- **Latency Regressions**: Rewritten endpoints often introduce hidden latency regressions under identical workloads.

`api-migration-harness` solves this by giving engineering teams a repeatable, automated harness to mirror requests across legacy and modern endpoints, deep-diff response payloads, and mathematically prove write idempotency.

---

## Key Features

- **Parallel Dual-Runner**: Dispatches requests concurrently to both endpoints, measures latency delta, and checks status code and payload parity.
- **Deep JSON Diffing Engine**: Pinpoints exact paths (`deal.line_items[0].unit_price`) for missing keys, unexpected keys, type mismatches, value diffs, and array length variations.
- **Write Idempotency Verifier**: Injects and replays `Idempotency-Key` headers across consecutive requests, verifying cache hits, response stability, and state non-duplication via count probes.
- **Built-in Mock CRM Server**: Ships with a ready-to-run CRM Deals & Line-Items API simulating legacy v1 (non-idempotent) vs modern v2 (strictly idempotent).
- **Automation-Ready**: First-class `--json` mode emits stable `{ ok, data, error }` envelopes for CI/CD pipelines, script piping (`| jq`), and alerting.
- **Predictable Exit Codes**: Follows Unix standard conventions:
  - `0`: Parity confirmed / diff identical / write idempotent.
  - `1`: Operational failure or parity drift detected.
  - `2`: Usage error (missing flags, unknown commands).

---

## Quickstart

### 1. Installation

Clone and install dependencies with Bun:

```bash
git clone https://github.com/nadimtuhin/api-migration-harness.git
cd api-migration-harness
bun install
```

### 2. Start the Mock Server

Spin up the built-in CRM mock API (legacy v1 vs modern v2):

```bash
bun run mock
# Server running at http://localhost:4000
```

### 3. Dual-Run Parity Check

Compare responses from legacy and modern endpoints:

```bash
# Test endpoints that have achieved parity (exits 0)
bun run cli dual-run \
  --legacy http://localhost:4000/v1/parity/deals \
  --modern http://localhost:4000/v2/parity/deals

# Test legacy v1 vs modern v2 to detect schema evolution (exits 1)
bun run cli dual-run \
  --legacy http://localhost:4000/v1/deals \
  --modern http://localhost:4000/v2/deals
```

### 4. Verify Write Idempotency

Send duplicate writes with `Idempotency-Key` and probe state counts:

```bash
# Modern v2 (Idempotent - exits 0)
bun run cli idempotent \
  --url http://localhost:4000/v2/deals \
  --body '{"name":"Acme Enterprise Deal","amount":50000}' \
  --probe http://localhost:4000/v2/deals

# Legacy v1 (Vulnerable to double writes - exits 1)
bun run cli idempotent \
  --url http://localhost:4000/v1/deals \
  --body '{"name":"Legacy Deal","amount_cents":5000000}' \
  --probe http://localhost:4000/v1/deals
```

---

## CLI Usage

### Commands

| Command | Description |
|---|---|
| `dual-run` | Send parallel requests to legacy and modern URLs and compare parity |
| `diff` | Deep structural diffing between two JSON payloads or file paths |
| `idempotent` | Replay requests with `Idempotency-Key` and verify no duplicate writes occur |
| `mock` | Start the built-in CRM Deals mock API server |

### Global Flags

- `--json`: Output machine-readable JSON envelope.
- `--help`, `-h`: Print help message.
- `--version`, `-v`: Print CLI version.

---

### Command: `dual-run`

```bash
api-migration-harness dual-run [options]

Options:
  --legacy <url>       Legacy API URL (required)
  --modern <url>       Modern API URL (required)
  --method <method>    HTTP method (GET, POST, PUT, DELETE... default: GET)
  --body <json|@file>  Request body string or file path prefixed with @
  --header <header>    Header formatted as 'Name: Value' (repeatable)
  --ignore <paths>     Comma-separated JSON paths to ignore (e.g. 'created_at,*.id')
  --timeout <ms>       Request timeout in ms (default: 10000)
  --json               Output JSON envelope
```

### Command: `diff`

```bash
api-migration-harness diff [options]

Options:
  -a, --legacy <json|@file>  Left/Legacy JSON string or @filepath (required)
  -b, --modern <json|@file>  Right/Modern JSON string or @filepath (required)
  --ignore <paths>           Comma-separated paths to ignore in diff
  --tolerance <float>        Numeric tolerance threshold for float comparison
  --json                     Output JSON envelope
```

### Command: `idempotent`

```bash
api-migration-harness idempotent [options]

Options:
  --url <url>          Target API endpoint URL (required)
  --method <method>    HTTP method (default: POST)
  --body <json|@file>  Request body string or file path prefixed with @
  --key <uuid>         Explicit Idempotency-Key (default: generated UUID)
  --key-header <name>  Idempotency header name (default: Idempotency-Key)
  --repeat <count>     Number of duplicate requests to send (default: 2)
  --probe <url>        GET endpoint to probe record count before and after
  --ignore <paths>     Comma-separated paths to ignore in response diffs
  --json               Output JSON envelope
```

---

## Demo Output

### 1. Parity Verified (`dual-run`)

```text
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 DUAL-RUN PARITY REPORT: PASSED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Overall Parity:     ✓ PARITY VERIFIED
HTTP Status:        ✓ Legacy 200 vs Modern 200
Latency (Legacy):   1.42ms
Latency (Modern):   0.98ms (-0.44ms)

--- Response Diff ---
✓ Responses are identical.
```

### 2. Schema Drift Detected (`dual-run`)

```text
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 DUAL-RUN PARITY REPORT: FAILED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Overall Parity:     ✗ DRIFT DETECTED
HTTP Status:        ✓ Legacy 200 vs Modern 200
Latency (Legacy):   1.12ms
Latency (Modern):   1.05ms (-0.07ms)

--- Response Diff ---
✗ Found 6 difference(s):
  • [MISSING_KEY] $[0].deal_id
    - Legacy: "dl_001"
  • [MISSING_KEY] $[0].amount_cents
    - Legacy: 1500000
  • [MISSING_KEY] $[0].line_items
    - Legacy: [{"line_id":"li_001",...}]
  • [UNEXPECTED_KEY] $[0].id
    + Modern: "dl_001"
  • [UNEXPECTED_KEY] $[0].amount
    + Modern: 15000
  • [UNEXPECTED_KEY] $[0].lineItems
    + Modern: [{"id":"li_001",...}]
```

### 3. Idempotency Check (`idempotent`)

```text
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 IDEMPOTENCY TEST: PASSED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Status:              ✓ IDEMPOTENT
Idempotency-Key:     15934ce6-b6d7-4102-91b3-6a1f237d53c2
Total Invocations:   3
Status Consistency:  ✓ (201 -> 201 -> 201)
Body Consistency:    ✓
Double Write:        ✓ None detected
Probe Count:         Before: 1 -> After: 2 (delta: +1)

Attempts Breakdown:
  Attempt #1: HTTP 201 in 1.39ms
  Attempt #2: HTTP 201 in 0.26ms [CACHE HIT]
  Attempt #3: HTTP 201 in 0.22ms [CACHE HIT]

Result: Endpoint successfully honored Idempotency-Key across 3 requests. No duplicate records created.
```

### 4. Machine-Readable JSON Envelope (`--json`)

```json
{
  "ok": true,
  "data": {
    "passed": true,
    "idempotencyKey": "15934ce6-b6d7-4102-91b3-6a1f237d53c2",
    "statusConsistent": true,
    "bodyConsistent": true,
    "doubleWriteDetected": false,
    "runs": [
      {
        "attempt": 1,
        "status": 201,
        "durationMs": 1.39,
        "cacheHit": false
      },
      {
        "attempt": 2,
        "status": 201,
        "durationMs": 0.26,
        "cacheHit": true
      }
    ],
    "probeResults": {
      "initialCount": 1,
      "finalCount": 2,
      "countDifference": 1
    },
    "details": "Endpoint successfully honored Idempotency-Key across 3 requests. No duplicate records created."
  },
  "error": null
}
```

---

## Programmatic TypeScript API

You can also embed the harness directly in your automated test suites:

```typescript
import { dualRun, diffJson, testIdempotency } from "api-migration-harness";

// 1. Dual-Run
const parityResult = await dualRun({
  legacyUrl: "https://api-legacy.internal/orders",
  modernUrl: "https://api-modern.internal/orders",
  method: "POST",
  body: { customerId: 100 },
  ignorePaths: ["timestamp", "metadata.requestId"],
});

console.log(parityResult.parity); // boolean

// 2. Deep Diff
const diff = diffJson(
  { total: 100, tax: 10 },
  { total: 100, tax: "10" }
);
console.log(diff.summary.typeMismatches); // 1

// 3. Test Idempotency
const idempotency = await testIdempotency({
  url: "https://api-modern.internal/charges",
  body: { amount: 2500 },
  repeatCount: 2,
  probeUrl: "https://api-modern.internal/charges",
});

console.log(idempotency.doubleWriteDetected); // false
```

---

## Architecture

```
api-migration-harness
├── src/
│   ├── cli.ts          # Registry-driven CLI, flag parsing & dispatch
│   ├── index.ts        # Public API exports
│   ├── diff.ts         # Pure recursive JSON diff engine & path matching
│   ├── runner.ts       # Parallel dual execution & latency instrumentation
│   ├── idempotency.ts  # Write replay loop & double-write detection
│   └── types.ts        # Discriminated union envelopes & shared schemas
├── mock/
│   └── server.ts       # CRM Deals API mock (v1 legacy vs v2 modern)
└── tests/
    ├── diff.test.ts    # Deep diff engine unit tests
    ├── runner.test.ts  # Dual-run integration tests
    ├── idempotency.test.ts # Idempotency validation tests
    └── cli.test.ts     # Process-boundary e2e CLI tests
```

---

## Running Tests

Run the test suite using Bun's native test runner:

```bash
bun test
```

All 30 unit, integration, and CLI e2e tests execute in under 400ms.

---

## License

MIT © [Nadim Tuhin](https://github.com/nadimtuhin)
