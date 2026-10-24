import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import http from "node:http";

const require = createRequire(import.meta.url);
const quota = require("../../cli/src/cli/commands/quota.js");
const { parseArgs, formatCost, computeOverviewTotals } = quota.__test__;

const MOCK_STATS = {
  totalRequests: 150,
  totalPromptTokens: 12000,
  totalCompletionTokens: 3000,
  totalCachedTokens: 4000,
  totalCost: 1.25,
  byProvider: {
    anthropic: {
      requests: 100,
      promptTokens: 8000,
      completionTokens: 2000,
      cachedTokens: 4000,
      cost: 1.0,
    },
    openai: {
      requests: 50,
      promptTokens: 4000,
      completionTokens: 1000,
      cachedTokens: 0,
      cost: 0.25,
    },
  },
  byModel: {
    "claude-3-7-sonnet": {
      rawModel: "claude-3-7-sonnet",
      provider: "anthropic",
      requests: 100,
      promptTokens: 8000,
      completionTokens: 2000,
      cachedTokens: 4000,
      cost: 1.0,
      lastUsed: "2026-10-24T10:00:00.000Z",
    },
    "gpt-4o": {
      rawModel: "gpt-4o",
      provider: "openai",
      requests: 50,
      promptTokens: 4000,
      completionTokens: 1000,
      cachedTokens: 0,
      cost: 0.25,
      lastUsed: "2026-10-24T11:00:00.000Z",
    },
  },
};

function startMockServer(statusCode = 200, payload = MOCK_STATS) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

const closeMockServer = (server) => new Promise((resolve) => server.close(resolve));

describe("9router quota parseArgs", () => {
  it("defaults to period: 'all' and no provider", () => {
    const opts = parseArgs([]);
    expect(opts).toEqual({
      period: "all",
      provider: null,
      json: false,
      help: false,
    });
  });

  it("parses -p and --period", () => {
    expect(parseArgs(["-p", "24h"]).period).toBe("24h");
    expect(parseArgs(["--period", "7d"]).period).toBe("7d");
    expect(parseArgs(["-p", "today"]).period).toBe("today");
    expect(parseArgs(["-p", "30d"]).period).toBe("30d");
    expect(parseArgs(["-p", "all"]).period).toBe("all");
  });

  it("rejects missing value for period", () => {
    expect(() => parseArgs(["-p"])).toThrow(/Missing value for --period/);
    expect(() => parseArgs(["--period"])).toThrow(/Missing value for --period/);
  });

  it("rejects invalid period", () => {
    expect(() => parseArgs(["-p", "invalid"])).toThrow(/Invalid period/);
  });

  it("parses --provider", () => {
    expect(parseArgs(["--provider", "anthropic"]).provider).toBe("anthropic");
  });

  it("rejects missing value for --provider", () => {
    expect(() => parseArgs(["--provider"])).toThrow(/Missing value for --provider/);
  });

  it("parses --json flag", () => {
    expect(parseArgs(["--json"]).json).toBe(true);
  });

  it("parses -h and --help flags", () => {
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["--help"]).help).toBe(true);
  });

  it("rejects unknown options and positional args", () => {
    expect(() => parseArgs(["--unknown"])).toThrow(/Unknown option/);
    expect(() => parseArgs(["unexpected"])).toThrow(/Unexpected positional argument/);
  });
});

describe("formatCost", () => {
  it("formats positive numbers with 4 decimals and $ prefix", () => {
    expect(formatCost(1.23456)).toBe("$1.2346");
    expect(formatCost(0)).toBe("$0.0000");
  });

  it("handles non-numbers gracefully", () => {
    expect(formatCost(null)).toBe("$0.0000");
    expect(formatCost(undefined)).toBe("$0.0000");
    expect(formatCost(NaN)).toBe("$0.0000");
  });
});

describe("computeOverviewTotals", () => {
  it("computes overall totals when no provider filter is given", () => {
    const totals = computeOverviewTotals(MOCK_STATS, null);
    expect(totals).toEqual({
      totalRequests: 150,
      totalPromptTokens: 12000,
      totalCompletionTokens: 3000,
      totalCachedTokens: 4000,
      totalCost: 1.25,
    });
  });

  it("computes filtered totals for a matched provider (case-insensitive)", () => {
    const totals = computeOverviewTotals(MOCK_STATS, "Anthropic");
    expect(totals).toEqual({
      totalRequests: 100,
      totalPromptTokens: 8000,
      totalCompletionTokens: 2000,
      totalCachedTokens: 4000,
      totalCost: 1.0,
    });
  });

  it("returns zeros when provider filter does not match", () => {
    const totals = computeOverviewTotals(MOCK_STATS, "nonexistent");
    expect(totals).toEqual({
      totalRequests: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalCachedTokens: 0,
      totalCost: 0,
    });
  });
});

describe("9router quota run", () => {
  let mockServer;
  let mockPort;
  let logs;
  let errors;

  beforeEach(async () => {
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => errors.push(a.join(" ")));
    const s = await startMockServer();
    mockServer = s.server;
    mockPort = s.port;
    vi.stubEnv("PORT", String(mockPort));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (mockServer) {
      await closeMockServer(mockServer);
      mockServer = null;
    }
  });

  it("--help prints usage and exits 0", async () => {
    const code = await quota.run(["--help"]);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("Usage: 9router quota");
  });

  it("renders overview, provider table and model table", async () => {
    const code = await quota.run([]);
    expect(code).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("Overview");
    expect(output).toContain("Total Requests:");
    expect(output).toContain("Total Prompt Tokens:");
    expect(output).toContain("Total Completion Tokens:");
    expect(output).toContain("Total Cached Tokens:");
    expect(output).toContain("Total Cost ($):");
    expect(output).toContain("Provider");
    expect(output).toContain("anthropic");
    expect(output).toContain("openai");
    expect(output).toContain("Model");
    expect(output).toContain("claude-3-7-sonnet");
    expect(output).toContain("gpt-4o");
  });

  it("--json outputs raw JSON with stats", async () => {
    const code = await quota.run(["--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.totalRequests).toBe(150);
    expect(parsed.totalCost).toBe(1.25);
    expect(parsed.byProvider.anthropic).toBeDefined();
  });

  it("--provider filters overview, tables and json", async () => {
    const code = await quota.run(["--provider", "anthropic", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.totalRequests).toBe(100);
    expect(parsed.totalCost).toBe(1.0);
    expect(parsed.byProvider.anthropic).toBeDefined();
    expect(parsed.byProvider.openai).toBeUndefined();
    expect(parsed.byModel["claude-3-7-sonnet"]).toBeDefined();
    expect(parsed.byModel["gpt-4o"]).toBeUndefined();
  });

  it("handles gateway error gracefully and returns 1", async () => {
    await closeMockServer(mockServer);
    mockServer = null;
    // Set port to non-listening port
    vi.stubEnv("PORT", "59999");

    const code = await quota.run([]);
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/Error fetching quota/);
  });
});
