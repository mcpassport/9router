/**
 * `9router quota` — show token usage, breakdown by provider, and top models
 * from the local 9router gateway.
 */

const http = require("http");
const { showBox, showTable } = require("../utils/display");
const { formatNumber, formatDate } = require("../utils/format");

let client;
try {
  client = require("../api/client");
} catch {
  client = null;
}

const DEFAULT_PERIOD = "all";
const VALID_PERIODS = new Set(["today", "24h", "7d", "30d", "60d", "all"]);
const TOP_MODELS_LIMIT = 10;

const HELP = `
Usage: 9router quota [options]

Display token usage and costs from your 9router gateway.

Options:
  -p, --period <period>  Time range: today, 24h, 7d, 30d, all (default: all)
  --provider <name>      Filter by provider name
  --json                 Output raw JSON
  -h, --help             Show this help
`;

function parseArgs(argv) {
  const opts = {
    period: DEFAULT_PERIOD,
    provider: null,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-p" || a === "--period") {
      const v = argv[++i];
      if (v === undefined) throw new Error("Missing value for --period");
      if (!VALID_PERIODS.has(v)) {
        throw new Error(`Invalid period: ${v}. Supported: today, 24h, 7d, 30d, all`);
      }
      opts.period = v;
    } else if (a === "--provider") {
      const v = argv[++i];
      if (v === undefined) throw new Error("Missing value for --provider");
      opts.provider = v;
    } else if (a === "--json") {
      opts.json = true;
    } else if (a === "-h" || a === "--help") {
      opts.help = true;
    } else if (a.startsWith("-")) {
      throw new Error(`Unknown option: ${a}`);
    } else {
      throw new Error(`Unexpected positional argument: ${a}`);
    }
  }

  return opts;
}

function formatCost(cost) {
  const n = typeof cost === "number" && !isNaN(cost) ? cost : 0;
  return `$${n.toFixed(4)}`;
}

async function fetchStats(period) {
  if (client && typeof client.getUsageStats === "function") {
    try {
      const res = await client.getUsageStats(period);
      if (res && typeof res === "object") {
        if (res.success !== undefined) {
          if (!res.success) throw new Error(res.error || "Failed to fetch usage stats");
          return res.data;
        }
        return res;
      }
    } catch (err) {
      if (err.message && !err.message.includes("is not a function")) {
        throw err;
      }
    }
  }

  if (client && typeof client.makeRequest === "function") {
    const res = await client.makeRequest("GET", `/api/usage/stats?period=${encodeURIComponent(period)}`);
    if (res && !res.success) {
      throw new Error(res.error || "Failed to fetch usage stats");
    }
    return res.data;
  }

  return new Promise((resolve, reject) => {
    const port = process.env.PORT || 20128;
    const url = `http://localhost:${port}/api/usage/stats?period=${encodeURIComponent(period)}`;
    const req = http.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          if (res.statusCode >= 400 || parsed.error) {
            reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
          } else {
            resolve(parsed);
          }
        } catch (err) {
          reject(new Error(`Failed to parse response: ${err.message}`));
        }
      });
    });

    req.on("error", (err) => {
      reject(new Error(`Network error: ${err.message}`));
    });

    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
  });
}

function computeOverviewTotals(stats, providerFilter) {
  if (!providerFilter) {
    return {
      totalRequests: stats.totalRequests || 0,
      totalPromptTokens: stats.totalPromptTokens || 0,
      totalCompletionTokens: stats.totalCompletionTokens || 0,
      totalCachedTokens: stats.totalCachedTokens || 0,
      totalCost: stats.totalCost || 0,
    };
  }

  const provLower = providerFilter.toLowerCase();
  const entry = Object.entries(stats.byProvider || {})
    .find(([k]) => k.toLowerCase() === provLower);

  if (entry) {
    const p = entry[1];
    return {
      totalRequests: p.requests || 0,
      totalPromptTokens: p.promptTokens || 0,
      totalCompletionTokens: p.completionTokens || 0,
      totalCachedTokens: p.cachedTokens || 0,
      totalCost: p.cost || 0,
    };
  }

  return {
    totalRequests: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalCachedTokens: 0,
    totalCost: 0,
  };
}

function renderOverview(totals, providerFilter) {
  const title = providerFilter ? `Overview (${providerFilter})` : "Overview";
  const lines = [
    `Total Requests:           ${formatNumber(totals.totalRequests)}`,
    `Total Prompt Tokens:      ${formatNumber(totals.totalPromptTokens)}`,
    `Total Completion Tokens:  ${formatNumber(totals.totalCompletionTokens)}`,
    `Total Cached Tokens:      ${formatNumber(totals.totalCachedTokens)}`,
    `Total Cost ($):           ${formatCost(totals.totalCost)}`,
  ];

  const boxWidth = Math.max(60, title.length + 8);
  showBox(title, lines.join("\n"), boxWidth);
}

function renderProviderTable(stats, providerFilter) {
  const headers = [
    "Provider",
    "Requests",
    "Prompt Tokens",
    "Completion Tokens",
    "Cached Tokens",
    "Cost ($)",
  ];

  let entries = Object.entries(stats.byProvider || {});
  if (providerFilter) {
    const provLower = providerFilter.toLowerCase();
    entries = entries.filter(([p]) => p.toLowerCase() === provLower);
  }

  entries.sort(([, a], [, b]) => (b.requests || 0) - (a.requests || 0));

  const rows = entries.map(([provider, p]) => [
    provider,
    formatNumber(p.requests || 0),
    formatNumber(p.promptTokens || 0),
    formatNumber(p.completionTokens || 0),
    formatNumber(p.cachedTokens || 0),
    formatCost(p.cost || 0),
  ]);

  if (rows.length > 0) {
    console.log("");
    showTable(headers, rows);
  }
}

function renderModelTable(stats, providerFilter) {
  const headers = [
    "Model",
    "Provider",
    "Requests",
    "Tokens",
    "Cost ($)",
    "Last Used",
  ];

  let entries = Object.entries(stats.byModel || {});
  if (providerFilter) {
    const provLower = providerFilter.toLowerCase();
    entries = entries.filter(([, m]) => (m.provider || "").toLowerCase() === provLower);
  }

  entries.sort(([, a], [, b]) => (b.requests || 0) - (a.requests || 0));

  const topEntries = entries.slice(0, TOP_MODELS_LIMIT);

  const rows = topEntries.map(([key, m]) => {
    const modelName = m.rawModel || key;
    const providerName = m.provider || "unknown";
    const requests = formatNumber(m.requests || 0);
    const tokens = formatNumber((m.promptTokens || 0) + (m.completionTokens || 0));
    const cost = formatCost(m.cost || 0);
    let lastUsed = "-";
    if (m.lastUsed) {
      const formatted = formatDate(m.lastUsed);
      if (formatted !== "Invalid Date") {
        lastUsed = formatted;
      }
    }
    return [modelName, providerName, requests, tokens, cost, lastUsed];
  });

  if (rows.length > 0) {
    console.log("");
    showTable(headers, rows);
  }
}

async function run(argv = []) {
  const opts = parseArgs(argv);

  if (opts.help) {
    console.log(HELP.trim());
    return 0;
  }

  let stats;
  try {
    stats = await fetchStats(opts.period);
  } catch (err) {
    console.error(`Error fetching quota: ${err.message || err}`);
    return 1;
  }

  const totals = computeOverviewTotals(stats, opts.provider);

  if (opts.json) {
    if (opts.provider) {
      const provLower = opts.provider.toLowerCase();
      const filteredByProvider = {};
      for (const [k, v] of Object.entries(stats.byProvider || {})) {
        if (k.toLowerCase() === provLower) filteredByProvider[k] = v;
      }
      const filteredByModel = {};
      for (const [k, v] of Object.entries(stats.byModel || {})) {
        if ((v.provider || "").toLowerCase() === provLower) filteredByModel[k] = v;
      }
      const filteredStats = {
        ...stats,
        ...totals,
        byProvider: filteredByProvider,
        byModel: filteredByModel,
      };
      console.log(JSON.stringify(filteredStats, null, 2));
    } else {
      console.log(JSON.stringify(stats, null, 2));
    }
    return 0;
  }

  renderOverview(totals, opts.provider);
  renderProviderTable(stats, opts.provider);
  renderModelTable(stats, opts.provider);

  return 0;
}

module.exports = {
  run,
  __test__: {
    parseArgs,
    formatCost,
    computeOverviewTotals,
    fetchStats,
  },
};
