import { createRequire } from "node:module";

let describe, it, expect, beforeEach, afterEach, vi;

try {
  const v = await import("vitest");
  ({ describe, it, expect, beforeEach, afterEach, vi } = v);
} catch {
  const test = await import("node:test");
  const assert = await import("node:assert");
  describe = test.describe;
  it = test.it;
  beforeEach = test.beforeEach;
  afterEach = test.afterEach;
  expect = (actual) => ({
    toBe: (expected) => assert.strictEqual(actual, expected),
    toEqual: (expected) => assert.deepStrictEqual(actual, expected),
    toContain: (expected) => assert.ok(actual.includes(expected), `Expected "${actual}" to contain "${expected}"`),
    toHaveLength: (len) => assert.strictEqual(actual.length, len),
    toThrow: (re) => {
      let threw = false;
      try {
        actual();
      } catch (err) {
        threw = true;
        if (re) assert.match(err.message, re);
      }
      assert.ok(threw, "Expected function to throw");
    },
  });
  const spied = [];
  vi = {
    spyOn: (obj, method) => {
      const orig = obj[method];
      const calls = [];
      const fn = (...args) => {
        calls.push(args);
        return fn.impl ? fn.impl(...args) : undefined;
      };
      fn.calls = calls;
      fn.mockImplementation = (impl) => {
        fn.impl = impl;
        return fn;
      };
      fn.mockResolvedValue = (val) => {
        fn.impl = async () => val;
        return fn;
      };
      fn.mockRestore = () => {
        obj[method] = orig;
      };
      spied.push(fn);
      obj[method] = fn;
      return fn;
    },
    restoreAllMocks: () => {
      while (spied.length) {
        spied.pop().mockRestore();
      }
    },
  };
}

const require = createRequire(import.meta.url);
const logs = require("../../cli/src/cli/commands/logs.js");
const client = require("../../cli/src/cli/api/client.js");

describe("9router logs subcommand", () => {
  let logOutput = [];
  let errorOutput = [];

  beforeEach(() => {
    logOutput = [];
    errorOutput = [];
    vi.spyOn(console, "log").mockImplementation((...args) => logOutput.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args) => errorOutput.push(args.join(" ")));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("parseArgs", () => {
    const { parseArgs } = logs.__test__;

    it("parses defaults on empty argv", () => {
      const opts = parseArgs([]);
      expect(opts).toEqual({
        lines: 30,
        follow: false,
        model: null,
        combo: null,
        routing: false,
        query: null,
        json: false,
        help: false,
      });
    });

    it("parses -n / --lines flags", () => {
      expect(parseArgs(["-n", "10"]).lines).toBe(10);
      expect(parseArgs(["--lines", "50"]).lines).toBe(50);
      expect(parseArgs(["--lines=25"]).lines).toBe(25);
      expect(parseArgs(["-n15"]).lines).toBe(15);
    });

    it("throws on missing or invalid --lines", () => {
      expect(() => parseArgs(["-n"])).toThrow(/Missing or invalid value/);
      expect(() => parseArgs(["-n", "abc"])).toThrow(/Missing or invalid value/);
      expect(() => parseArgs(["--lines="])).toThrow(/Missing or invalid value/);
    });

    it("parses -f / --follow", () => {
      expect(parseArgs(["-f"]).follow).toBe(true);
      expect(parseArgs(["--follow"]).follow).toBe(true);
    });

    it("parses -m / --model", () => {
      expect(parseArgs(["-m", "gpt-4o"]).model).toBe("gpt-4o");
      expect(parseArgs(["--model", "claude-3"]).model).toBe("claude-3");
      expect(parseArgs(["--model=gemini"]).model).toBe("gemini");
      expect(() => parseArgs(["-m"])).toThrow(/Missing value for --model/);
    });

    it("parses -c / --combo", () => {
      expect(parseArgs(["-c", "fast-route"]).combo).toBe("fast-route");
      expect(parseArgs(["--combo", "smart"]).combo).toBe("smart");
      expect(parseArgs(["--combo=smart"]).combo).toBe("smart");
      expect(() => parseArgs(["-c"])).toThrow(/Missing value for --combo/);
    });

    it("parses -r / --routing", () => {
      expect(parseArgs(["-r"]).routing).toBe(true);
      expect(parseArgs(["--routing"]).routing).toBe(true);
    });

    it("parses -q / --query", () => {
      expect(parseArgs(["-q", "timeout"]).query).toBe("timeout");
      expect(parseArgs(["--query", "error"]).query).toBe("error");
      expect(parseArgs(["--query=fail"]).query).toBe("fail");
      expect(() => parseArgs(["-q"])).toThrow(/Missing value for --query/);
    });

    it("parses --json flag", () => {
      expect(parseArgs(["--json"]).json).toBe(true);
    });

    it("parses -h / --help flag", () => {
      expect(parseArgs(["-h"]).help).toBe(true);
      expect(parseArgs(["--help"]).help).toBe(true);
    });

    it("supports combined flags like -fr", () => {
      const opts = parseArgs(["-fr"]);
      expect(opts.follow).toBe(true);
      expect(opts.routing).toBe(true);
    });

    it("throws on unknown option", () => {
      expect(() => parseArgs(["--unknown-flag"])).toThrow(/Unknown option/);
    });
  });

  describe("filterLine", () => {
    const { filterLine } = logs.__test__;

    it("returns false for non-string input", () => {
      expect(filterLine(null)).toBe(false);
      expect(filterLine(undefined)).toBe(false);
      expect(filterLine(123)).toBe(false);
    });

    it("passes plain lines when no filter is set", () => {
      expect(filterLine("any plain log line", {})).toBe(true);
    });

    it("filters by routing tags", () => {
      expect(filterLine("[12:00:00] [COMBO MATCH] smart-combo", { routing: true })).toBe(true);
      expect(filterLine("[12:00:00] [WIRE ROUTE] wire dispatch", { routing: true })).toBe(true);
      expect(filterLine("[12:00:00] [ROUTER] request received", { routing: true })).toBe(true);
      expect(filterLine("[12:00:00] [DISPATCH] upstream call", { routing: true })).toBe(true);
      expect(filterLine("[12:00:00] [INFO] standard log line", { routing: true })).toBe(false);
    });

    it("filters by model case-insensitively", () => {
      expect(filterLine("Model gpt-4o invoked", { model: "GPT-4O" })).toBe(true);
      expect(filterLine("Model claude-3 invoked", { model: "GPT-4O" })).toBe(false);
    });

    it("filters by combo case-insensitively", () => {
      expect(filterLine("Combo: SMART-ROUTER matched", { combo: "smart-router" })).toBe(true);
      expect(filterLine("Combo: fast-router matched", { combo: "smart-router" })).toBe(false);
    });

    it("filters by generic query", () => {
      expect(filterLine("Connection error: ETIMEDOUT", { query: "error" })).toBe(true);
      expect(filterLine("Connection error: ETIMEDOUT", { query: "ERROR" })).toBe(true);
      expect(filterLine("Connection successful", { query: "error" })).toBe(false);
    });

    it("combines multiple filters correctly", () => {
      const line = '[ROUTER] [COMBO MATCH] combo: "smart" model: gpt-4o';
      expect(filterLine(line, { routing: true, model: "gpt-4o", combo: "smart" })).toBe(true);
      expect(filterLine(line, { routing: true, model: "claude" })).toBe(false);
      expect(filterLine(line, { routing: true, query: "not-present" })).toBe(false);
    });
  });

  describe("colorizeLine", () => {
    const { colorizeLine } = logs.__test__;

    it("colorizes [COMBO MATCH] in cyan", () => {
      const res = colorizeLine("[COMBO MATCH] matched smart");
      expect(res).toContain("\x1b[36m");
      expect(res).toContain("\x1b[0m");
    });

    it("colorizes [WIRE ROUTE] in magenta", () => {
      const res = colorizeLine("[WIRE ROUTE] dispatching to OpenAI");
      expect(res).toContain("\x1b[35m");
      expect(res).toContain("\x1b[0m");
    });

    it("colorizes [ERROR] in red", () => {
      const res = colorizeLine("[ERROR] Failed to connect");
      expect(res).toContain("\x1b[31m");
      expect(res).toContain("\x1b[0m");
    });

    it("colorizes [WARN] in yellow", () => {
      const res = colorizeLine("[WARN] Rate limit approaching");
      expect(res).toContain("\x1b[33m");
      expect(res).toContain("\x1b[0m");
    });

    it("leaves untagged lines uncolored", () => {
      const plain = "Regular info message";
      expect(colorizeLine(plain)).toBe(plain);
    });
  });

  describe("run subcommand", () => {
    it("prints help and returns 0 when --help is passed", async () => {
      const code = await logs.run(["--help"]);
      expect(code).toBe(0);
      expect(logOutput.join("\n")).toContain("Usage: 9router logs");
      expect(logOutput.join("\n")).toContain("-f, --follow");
    });

    it("displays recent history in a formatted table", async () => {
      vi.spyOn(client, "getRecentLogs").mockResolvedValue({
        success: true,
        data: [
          "24-10-2026 12:00:00 | gpt-4o | OPENAI | Account1 | 120 | 45 | ok",
          "24-10-2026 12:01:00 | claude-3 | ANTHROPIC | Account2 | 200 | 80 | ok",
        ],
      });

      const code = await logs.run(["-n", "10"]);
      expect(code).toBe(0);
      const text = logOutput.join("\n");
      expect(text).toContain("Timestamp");
      expect(text).toContain("Provider");
      expect(text).toContain("Model");
      expect(text).toContain("gpt-4o");
      expect(text).toContain("OPENAI");
    });

    it("filters history by model and supports --json", async () => {
      vi.spyOn(client, "getRecentLogs").mockResolvedValue({
        success: true,
        data: [
          "24-10-2026 12:00:00 | gpt-4o | OPENAI | Account1 | 120 | 45 | ok",
          "24-10-2026 12:01:00 | claude-3-opus | ANTHROPIC | Account2 | 200 | 80 | ok",
        ],
      });

      const code = await logs.run(["-m", "opus", "--json"]);
      expect(code).toBe(0);
      const parsed = JSON.parse(logOutput.join("\n"));
      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toEqual({
        timestamp: "24-10-2026 12:01:00",
        provider: "ANTHROPIC",
        model: "claude-3-opus",
        account: "Account2",
        prompt: "200",
        completion: "80",
        status: "ok",
      });
    });

    it("handles empty logs history gracefully", async () => {
      vi.spyOn(client, "getRecentLogs").mockResolvedValue({
        success: true,
        data: [],
      });

      const code = await logs.run([]);
      expect(code).toBe(0);
      expect(logOutput.join("\n")).toContain("No logs found.");
    });

    it("handles server failure and returns 1", async () => {
      vi.spyOn(client, "getRecentLogs").mockResolvedValue({
        success: false,
        error: "Server unavailable",
      });
      vi.spyOn(client, "makeRequest").mockResolvedValue({
        success: false,
        error: "Server unavailable",
      });

      const code = await logs.run([]);
      expect(code).toBe(1);
      expect(errorOutput.join("\n")).toContain("Failed to fetch logs");
    });
  });
});
