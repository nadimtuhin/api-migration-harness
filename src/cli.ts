#!/usr/bin/env bun
import { diffJson, formatDiffReport } from "./diff.ts";
import { dualRun, formatDualRunReport } from "./runner.ts";
import { testIdempotency, formatIdempotencyReport } from "./idempotency.ts";
import { createMockServer } from "../mock/server.ts";
import type { Envelope } from "./types.ts";

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface FlagSpec {
  name: string;
  desc: string;
  takesValue?: boolean;
  required?: boolean;
  alias?: string;
}

export interface CommandSpec {
  name: string;
  desc: string;
  flags: FlagSpec[];
  example?: string;
}

export const GLOBAL_FLAGS: FlagSpec[] = [
  { name: "json", desc: "Emit machine-readable JSON envelope", takesValue: false },
  { name: "help", desc: "Show usage help", takesValue: false, alias: "h" },
  { name: "version", desc: "Show version", takesValue: false, alias: "v" },
];

export const COMMANDS: Record<string, CommandSpec> = {
  "dual-run": {
    name: "dual-run",
    desc: "Run request against legacy & modern endpoints in parallel and verify parity",
    flags: [
      { name: "legacy", desc: "Legacy API URL", takesValue: true, required: true },
      { name: "modern", desc: "Modern API URL", takesValue: true, required: true },
      { name: "method", desc: "HTTP method (GET, POST, PUT... default: GET)", takesValue: true },
      { name: "body", desc: "Request payload JSON string or @filepath", takesValue: true },
      { name: "header", desc: "Header as 'Header: Value' (repeatable)", takesValue: true },
      { name: "ignore", desc: "Comma-separated paths to ignore in diff (e.g. 'created_at,*.id')", takesValue: true },
      { name: "timeout", desc: "Request timeout in milliseconds", takesValue: true },
    ],
    example: "api-migration-harness dual-run --legacy http://api.v1/deals --modern http://api.v2/deals",
  },
  diff: {
    name: "diff",
    desc: "Perform deep structural diffing between two JSON payloads or files",
    flags: [
      { name: "legacy", desc: "Legacy JSON string or @filepath", takesValue: true, alias: "a" },
      { name: "modern", desc: "Modern JSON string or @filepath", takesValue: true, alias: "b" },
      { name: "ignore", desc: "Comma-separated paths to ignore in diff", takesValue: true },
      { name: "tolerance", desc: "Numeric tolerance threshold for float comparison", takesValue: true },
    ],
    example: "api-migration-harness diff --legacy @v1.json --modern @v2.json --ignore 'created_at'",
  },
  idempotent: {
    name: "idempotent",
    desc: "Test endpoint write idempotency across repeated requests with Idempotency-Key",
    flags: [
      { name: "url", desc: "Target API endpoint URL", takesValue: true, required: true },
      { name: "method", desc: "HTTP method (default: POST)", takesValue: true },
      { name: "body", desc: "Request payload JSON string or @filepath", takesValue: true },
      { name: "key", desc: "Explicit Idempotency-Key to send (defaults to random UUID)", takesValue: true },
      { name: "key-header", desc: "Header name for idempotency key (default: Idempotency-Key)", takesValue: true },
      { name: "header", desc: "Additional header as 'Header: Value'", takesValue: true },
      { name: "repeat", desc: "Number of duplicate repeat requests (default: 2)", takesValue: true },
      { name: "probe", desc: "GET URL to probe item count before & after to detect double writes", takesValue: true },
      { name: "ignore", desc: "Comma-separated paths to ignore in diff", takesValue: true },
    ],
    example: "api-migration-harness idempotent --url http://api.v2/deals --body '{\"name\":\"Acme\"}' --probe http://api.v2/deals",
  },
  mock: {
    name: "mock",
    desc: "Start built-in CRM mock API server (simulating v1 legacy vs v2 modern)",
    flags: [
      { name: "port", desc: "Port to listen on (default: 4000)", takesValue: true },
    ],
    example: "api-migration-harness mock --port 4000",
  },
};

export interface ParsedArgs {
  command?: string;
  positionals: string[];
  flags: Record<string, string | boolean | string[]>;
  isJson: boolean;
  isHelp: boolean;
  isVersion: boolean;
}

export function parseArgs(rawArgs: string[]): ParsedArgs {
  const flags: Record<string, string | boolean | string[]> = {};
  const positionals: string[] = [];

  // Determine boolean flags from globals and all commands
  const booleanFlagSet = new Set<string>(["json", "help", "h", "version", "v"]);
  for (const cmd of Object.values(COMMANDS)) {
    for (const f of cmd.flags) {
      if (f.takesValue === false) {
        booleanFlagSet.add(f.name);
        if (f.alias) booleanFlagSet.add(f.alias);
      }
    }
  }

  let i = 0;
  let terminatorReached = false;

  while (i < rawArgs.length) {
    const token = rawArgs[i];

    if (!terminatorReached && token === "--") {
      terminatorReached = true;
      i++;
      continue;
    }

    if (terminatorReached) {
      positionals.push(token);
      i++;
      continue;
    }

    if (token.startsWith("--") || (token.startsWith("-") && token.length > 1 && !/^\d/.test(token))) {
      let rawName = token.startsWith("--") ? token.slice(2) : token.slice(1);
      let inlineValue: string | undefined = undefined;

      if (rawName.includes("=")) {
        const eqIdx = rawName.indexOf("=");
        inlineValue = rawName.slice(eqIdx + 1);
        rawName = rawName.slice(0, eqIdx);
      }

      const isBool = booleanFlagSet.has(rawName);

      if (inlineValue !== undefined) {
        assignFlag(flags, rawName, inlineValue);
        i++;
      } else if (isBool) {
        assignFlag(flags, rawName, true);
        i++;
      } else {
        // Flag takes value
        const nextToken = rawArgs[i + 1];
        if (nextToken === undefined || nextToken.startsWith("-")) {
          throw new UsageError(`Flag --${rawName} requires a value`);
        }
        assignFlag(flags, rawName, nextToken);
        i += 2;
      }
    } else {
      positionals.push(token);
      i++;
    }
  }

  const command = positionals[0];
  const restPositionals = positionals.slice(1);

  const isJson = Boolean(flags["json"]);
  const isHelp = Boolean(flags["help"] || flags["h"]);
  const isVersion = Boolean(flags["version"] || flags["v"]);

  return {
    command,
    positionals: restPositionals,
    flags,
    isJson,
    isHelp,
    isVersion,
  };
}

function assignFlag(
  flags: Record<string, string | boolean | string[]>,
  name: string,
  value: string | boolean
) {
  // Support repeatable flags (e.g. multiple --header)
  if (name in flags) {
    const existing = flags[name];
    if (Array.isArray(existing)) {
      existing.push(String(value));
    } else {
      flags[name] = [String(existing), String(value)];
    }
  } else {
    flags[name] = value;
  }
}

async function resolvePayload(input: unknown): Promise<unknown> {
  if (typeof input !== "string") return input;
  const str = input.trim();
  if (str.startsWith("@")) {
    const filePath = str.slice(1);
    const content = await Bun.file(filePath).text();
    try {
      return JSON.parse(content);
    } catch {
      return content;
    }
  }
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

function parseHeaders(headersFlag: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!headersFlag) return headers;

  const headerList = Array.isArray(headersFlag) ? headersFlag : [headersFlag];
  for (const item of headerList) {
    if (typeof item === "string") {
      const idx = item.indexOf(":");
      if (idx !== -1) {
        const k = item.slice(0, idx).trim();
        const v = item.slice(idx + 1).trim();
        headers[k] = v;
      }
    }
  }
  return headers;
}

function renderHelp(commandName?: string): string {
  if (commandName && COMMANDS[commandName]) {
    const cmd = COMMANDS[commandName];
    const lines = [
      `Usage: api-migration-harness ${cmd.name} [options]`,
      "",
      `Description: ${cmd.desc}`,
      "",
      "Options:",
    ];
    for (const f of [...cmd.flags, ...GLOBAL_FLAGS]) {
      const alias = f.alias ? `-${f.alias}, ` : "    ";
      const val = f.takesValue !== false ? ` <value>` : "";
      lines.push(`  ${alias}--${f.name}${val}`.padEnd(28) + ` ${f.desc}`);
    }
    if (cmd.example) {
      lines.push("", "Example:", `  ${cmd.example}`);
    }
    return lines.join("\n");
  }

  const lines = [
    "api-migration-harness - Dual-run API migration testing and parity verification harness",
    "",
    "Usage: api-migration-harness <command> [options]",
    "",
    "Commands:",
  ];
  for (const [name, cmd] of Object.entries(COMMANDS)) {
    lines.push(`  ${name.padEnd(16)} ${cmd.desc}`);
  }
  lines.push("", "Global Options:");
  for (const f of GLOBAL_FLAGS) {
    const alias = f.alias ? `-${f.alias}, ` : "    ";
    lines.push(`  ${alias}--${f.name}`.padEnd(28) + ` ${f.desc}`);
  }
  lines.push("", "Run 'api-migration-harness <command> --help' for details on a command.");
  return lines.join("\n");
}

export async function runCli(args: string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`Error: ${err.message}`);
      return 2;
    }
    throw err;
  }

  if (parsed.isVersion) {
    console.log("api-migration-harness v0.1.0");
    return 0;
  }

  if (parsed.isHelp && !parsed.command) {
    console.log(renderHelp());
    return 0;
  }

  if (!parsed.command) {
    console.error("Error: Missing command.");
    console.error(renderHelp());
    return 2;
  }

  const cmd = COMMANDS[parsed.command];
  if (!cmd) {
    console.error(`Error: Unknown command "${parsed.command}".`);
    console.error(renderHelp());
    return 2;
  }

  if (parsed.isHelp) {
    console.log(renderHelp(parsed.command));
    return 0;
  }

  // Validate required flags
  for (const f of cmd.flags) {
    if (f.required) {
      const val = parsed.flags[f.name] ?? (f.alias ? parsed.flags[f.alias] : undefined);
      if (!val) {
        if (parsed.isJson) {
          const env: Envelope<null> = {
            ok: false,
            data: null,
            error: `Missing required flag: --${f.name}`,
          };
          console.log(JSON.stringify(env));
        } else {
          console.error(`Error: Missing required flag: --${f.name}`);
        }
        return 2;
      }
    }
  }

  try {
    switch (parsed.command) {
      case "dual-run": {
        const legacyUrl = String(parsed.flags["legacy"]);
        const modernUrl = String(parsed.flags["modern"]);
        const method = parsed.flags["method"] ? String(parsed.flags["method"]) : undefined;
        const bodyRaw = parsed.flags["body"];
        const body = bodyRaw ? await resolvePayload(bodyRaw) : undefined;
        const headers = parseHeaders(parsed.flags["header"]);
        const ignore = parsed.flags["ignore"]
          ? String(parsed.flags["ignore"]).split(",").map((s) => s.trim())
          : undefined;
        const timeoutMs = parsed.flags["timeout"] ? Number(parsed.flags["timeout"]) : undefined;

        const result = await dualRun({
          legacyUrl,
          modernUrl,
          method,
          headers,
          body,
          ignorePaths: ignore,
          timeoutMs,
        });

        if (parsed.isJson) {
          const envelope: Envelope<typeof result> = result.parity
            ? { ok: true, data: result, error: null }
            : {
                ok: false,
                data: result,
                error: "Parity drift detected between legacy and modern endpoints",
              };
          console.log(JSON.stringify(envelope, null, 2));
        } else {
          console.log(formatDualRunReport(result));
        }

        return result.parity ? 0 : 1;
      }

      case "diff": {
        const aVal = parsed.flags["legacy"] ?? parsed.flags["a"];
        const bVal = parsed.flags["modern"] ?? parsed.flags["b"];

        if (!aVal || !bVal) {
          throw new UsageError("diff requires both --legacy (-a) and --modern (-b) values");
        }

        const legacyObj = await resolvePayload(aVal);
        const modernObj = await resolvePayload(bVal);
        const ignore = parsed.flags["ignore"]
          ? String(parsed.flags["ignore"]).split(",").map((s) => s.trim())
          : undefined;
        const numericTolerance = parsed.flags["tolerance"]
          ? Number(parsed.flags["tolerance"])
          : undefined;

        const result = diffJson(legacyObj, modernObj, {
          ignorePaths: ignore,
          numericTolerance,
        });

        if (parsed.isJson) {
          const envelope: Envelope<typeof result> = result.identical
            ? { ok: true, data: result, error: null }
            : {
                ok: false,
                data: result,
                error: `Diff found ${result.summary.total} mismatch(es)`,
              };
          console.log(JSON.stringify(envelope, null, 2));
        } else {
          console.log(formatDiffReport(result));
        }

        return result.identical ? 0 : 1;
      }

      case "idempotent": {
        const url = String(parsed.flags["url"]);
        const method = parsed.flags["method"] ? String(parsed.flags["method"]) : "POST";
        const bodyRaw = parsed.flags["body"];
        const body = bodyRaw ? await resolvePayload(bodyRaw) : undefined;
        const key = parsed.flags["key"] ? String(parsed.flags["key"]) : undefined;
        const keyHeader = parsed.flags["key-header"] ? String(parsed.flags["key-header"]) : undefined;
        const headers = parseHeaders(parsed.flags["header"]);
        const repeat = parsed.flags["repeat"] ? Number(parsed.flags["repeat"]) : 2;
        const probe = parsed.flags["probe"] ? String(parsed.flags["probe"]) : undefined;
        const ignore = parsed.flags["ignore"]
          ? String(parsed.flags["ignore"]).split(",").map((s) => s.trim())
          : undefined;

        const result = await testIdempotency({
          url,
          method,
          body,
          key,
          keyHeader,
          headers,
          repeatCount: repeat,
          probeUrl: probe,
          ignorePaths: ignore,
        });

        if (parsed.isJson) {
          const envelope: Envelope<typeof result> = result.passed
            ? { ok: true, data: result, error: null }
            : {
                ok: false,
                data: result,
                error: result.details,
              };
          console.log(JSON.stringify(envelope, null, 2));
        } else {
          console.log(formatIdempotencyReport(result));
        }

        return result.passed ? 0 : 1;
      }

      case "mock": {
        const port = Number(parsed.flags["port"] || 4000);
        const server = createMockServer(port);
        console.log(`CRM Mock API running at ${server.url}`);
        console.log("Press Ctrl+C to terminate.");
        // Keep alive until SIGINT
        await new Promise(() => {});
        return 0;
      }

      default:
        console.error(`Unknown command: ${parsed.command}`);
        return 2;
    }
  } catch (err) {
    if (err instanceof UsageError) {
      if (parsed.isJson) {
        console.log(JSON.stringify({ ok: false, data: null, error: err.message }));
      } else {
        console.error(`Error: ${err.message}`);
      }
      return 2;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (parsed.isJson) {
      console.log(JSON.stringify({ ok: false, data: null, error: message }));
    } else {
      console.error(`Fatal: ${message}`);
    }
    return 1;
  }
}

if (import.meta.main) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exit(exitCode);
}
