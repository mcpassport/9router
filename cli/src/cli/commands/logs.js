/**
 * `9router logs [options]` — view recent request logs or stream logs in realtime.
 */

const http = require("http");
const https = require("https");
const client = require("../api/client");
const { showTable } = require("../utils/display");

const ROUTING_TAGS = ["[COMBO MATCH]", "[WIRE ROUTE]", "[ROUTER]", "[DISPATCH]"];

const HELP = `
Usage: 9router logs [options]

View recent request history or stream router logs in realtime.

Examples:
  9router logs                      # show 30 recent request logs
  9router logs -n 50                # show 50 recent request logs
  9router logs -f                   # stream logs live in realtime
  9router logs -f -r                # stream only routing/dispatch lines
  9router logs -m gpt-4o            # filter logs by model
  9router logs -c my-combo          # filter logs by combo name
  9router logs -q "error"           # search logs by query
  9router logs --json               # output recent logs as JSON

Options:
  -n, --lines <number>  Number of recent log lines to display (default: 30)
  -f, --follow          Stream logs live in realtime
  -m, --model <name>    Filter logs matching model name (case-insensitive)
  -c, --combo <name>    Filter logs matching combo name (case-insensitive)
  -r, --routing         Only show routing and dispatch lines
  -q, --query <text>    Generic text search filter
  --json                Output raw JSON (for non-stream mode)
  -h, --help            Show this help
`;

function parseArgs(argv = []) {
  const opts = {
    lines: 30,
    follow: false,
    model: null,
    combo: null,
    routing: false,
    query: null,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-n" || a === "--lines") {
      const v = argv[++i];
      if (v === undefined || isNaN(Number(v))) {
        throw new Error("Missing or invalid value for --lines");
      }
      opts.lines = parseInt(v, 10);
    } else if (a.startsWith("--lines=")) {
      const v = a.slice(8);
      if (!v || isNaN(Number(v))) throw new Error("Missing or invalid value for --lines");
      opts.lines = parseInt(v, 10);
    } else if (a.startsWith("-n") && a.length > 2) {
      const v = a.slice(2);
      if (isNaN(Number(v))) throw new Error("Missing or invalid value for --lines");
      opts.lines = parseInt(v, 10);
    } else if (a === "-f" || a === "--follow") {
      opts.follow = true;
    } else if (a === "-m" || a === "--model") {
      const v = argv[++i];
      if (v === undefined) throw new Error("Missing value for --model");
      opts.model = v;
    } else if (a.startsWith("--model=")) {
      opts.model = a.slice(8);
    } else if (a === "-c" || a === "--combo") {
      const v = argv[++i];
      if (v === undefined) throw new Error("Missing value for --combo");
      opts.combo = v;
    } else if (a.startsWith("--combo=")) {
      opts.combo = a.slice(8);
    } else if (a === "-r" || a === "--routing") {
      opts.routing = true;
    } else if (a === "-q" || a === "--query") {
      const v = argv[++i];
      if (v === undefined) throw new Error("Missing value for --query");
      opts.query = v;
    } else if (a.startsWith("--query=")) {
      opts.query = a.slice(8);
    } else if (a === "--json") {
      opts.json = true;
    } else if (a === "-h" || a === "--help") {
      opts.help = true;
    } else if (a.startsWith("-") && !a.startsWith("--") && a.length > 2 && /^[frh]+$/.test(a.slice(1))) {
      for (const ch of a.slice(1)) {
        if (ch === "f") opts.follow = true;
        else if (ch === "r") opts.routing = true;
        else if (ch === "h") opts.help = true;
      }
    } else {
      throw new Error(`Unknown option: ${a}`);
    }
  }

  return opts;
}

function filterLine(line, opts = {}) {
  if (typeof line !== "string") return false;

  if (opts.routing) {
    const matchesRouting = ROUTING_TAGS.some((tag) => line.includes(tag));
    if (!matchesRouting) return false;
  }

  if (opts.model && !line.toLowerCase().includes(opts.model.toLowerCase())) {
    return false;
  }

  if (opts.combo && !line.toLowerCase().includes(opts.combo.toLowerCase())) {
    return false;
  }

  if (opts.query && !line.toLowerCase().includes(opts.query.toLowerCase())) {
    return false;
  }

  return true;
}

function colorizeLine(line) {
  if (typeof line !== "string") return line;
  if (line.includes("[COMBO MATCH]")) return `\x1b[36m${line}\x1b[0m`;
  if (line.includes("[WIRE ROUTE]")) return `\x1b[35m${line}\x1b[0m`;
  if (line.includes("[ERROR]")) return `\x1b[31m${line}\x1b[0m`;
  if (line.includes("[WARN]")) return `\x1b[33m${line}\x1b[0m`;
  return line;
}

function parseLogEntry(entry) {
  if (typeof entry === "string") {
    const parts = entry.split(" | ").map((s) => s.trim());
    return {
      timestamp: parts[0] || "-",
      model: parts[1] || "-",
      provider: parts[2] || "-",
      account: parts[3] || "-",
      prompt: parts[4] || "-",
      completion: parts[5] || "-",
      status: parts[6] || "-",
      raw: entry,
    };
  }
  if (entry && typeof entry === "object") {
    return {
      timestamp: entry.timestamp || entry.time || "-",
      provider: (entry.provider || "-").toUpperCase(),
      model: entry.model || "-",
      account: entry.account || entry.accountName || entry.connectionId || "-",
      prompt: String(entry.promptTokens ?? entry.prompt ?? entry.sent ?? "-"),
      completion: String(entry.completionTokens ?? entry.completion ?? entry.received ?? "-"),
      status: entry.status || "-",
      raw: JSON.stringify(entry),
    };
  }
  return null;
}

function filterHistoryItem(item, opts = {}) {
  if (!item) return false;

  if (opts.routing) {
    const matchesRouting = ROUTING_TAGS.some((tag) => item.raw.includes(tag));
    if (!matchesRouting) return false;
  }

  if (opts.model && !item.model.toLowerCase().includes(opts.model.toLowerCase())) {
    return false;
  }

  if (opts.combo) {
    const c = opts.combo.toLowerCase();
    const matchesCombo = item.model.toLowerCase().includes(c) || item.raw.toLowerCase().includes(c);
    if (!matchesCombo) return false;
  }

  if (opts.query) {
    const q = opts.query.toLowerCase();
    const matchesQuery =
      item.raw.toLowerCase().includes(q) ||
      item.timestamp.toLowerCase().includes(q) ||
      item.provider.toLowerCase().includes(q) ||
      item.model.toLowerCase().includes(q) ||
      item.account.toLowerCase().includes(q) ||
      item.prompt.toLowerCase().includes(q) ||
      item.completion.toLowerCase().includes(q) ||
      item.status.toLowerCase().includes(q);
    if (!matchesQuery) return false;
  }

  return true;
}

function fetchLogsFallback() {
  return new Promise((resolve, reject) => {
    const cfg = typeof client.getConfig === "function" ? client.getConfig() : {};
    const host = cfg.host || "localhost";
    const port = cfg.port || 20128;
    const protocol = cfg.protocol || "http:";
    const httpMod = protocol === "https:" ? https : http;
    const token = typeof client.getCliToken === "function" ? client.getCliToken() : "";

    const req = httpMod.request(
      {
        hostname: host,
        port,
        path: "/api/usage/logs",
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "x-9r-cli-token": token,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode >= 400) {
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse logs response: ${e.message}`));
          }
        });
      }
    );

    req.on("error", (err) => reject(new Error(`Failed to connect to 9router: ${err.message}`)));
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
    req.end();
  });
}

async function fetchLogs() {
  if (typeof client.getRecentLogs === "function") {
    try {
      const res = await client.getRecentLogs();
      if (res && res.success && Array.isArray(res.data)) return res.data;
      if (Array.isArray(res)) return res;
      if (res && res.error) throw new Error(res.error);
    } catch (e) {
      if (!e.message?.includes("Network error") && !e.message?.includes("Failed to connect")) {
        throw e;
      }
    }
  }

  if (typeof client.makeRequest === "function") {
    try {
      const res = await client.makeRequest("GET", "/api/usage/logs");
      if (res && res.success && Array.isArray(res.data)) return res.data;
      if (Array.isArray(res)) return res;
      if (res && res.error) throw new Error(res.error);
    } catch (e) {
      if (!e.message?.includes("Network error") && !e.message?.includes("Failed to connect")) {
        throw e;
      }
    }
  }

  return fetchLogsFallback();
}

async function showHistory(opts) {
  let rawLogs;
  try {
    rawLogs = await fetchLogs();
  } catch (err) {
    console.error(`❌ Failed to fetch logs: ${err.message}`);
    return 1;
  }

  if (!Array.isArray(rawLogs)) {
    console.error("❌ Invalid logs format received from server");
    return 1;
  }

  const items = rawLogs.map(parseLogEntry).filter(Boolean);
  const filtered = items.filter((item) => filterHistoryItem(item, opts));
  const displayed = filtered.slice(0, opts.lines);

  if (opts.json) {
    const jsonOutput = displayed.map((item) => ({
      timestamp: item.timestamp,
      provider: item.provider,
      model: item.model,
      account: item.account,
      prompt: item.prompt,
      completion: item.completion,
      status: item.status,
    }));
    console.log(JSON.stringify(jsonOutput, null, 2));
    return 0;
  }

  if (displayed.length === 0) {
    console.log("No logs found.");
    return 0;
  }

  const headers = ["Timestamp", "Provider", "Model", "Account", "Prompt", "Completion", "Status"];
  const rows = displayed.map((item) => [
    item.timestamp,
    item.provider,
    item.model,
    item.account,
    item.prompt,
    item.completion,
    item.status,
  ]);
  showTable(headers, rows);
  return 0;
}

function followLogs(opts) {
  return new Promise((resolve) => {
    const cfg = typeof client.getConfig === "function" ? client.getConfig() : {};
    const host = cfg.host || "localhost";
    const port = cfg.port || 20128;
    const protocol = cfg.protocol || "http:";
    const httpMod = protocol === "https:" ? https : http;
    const token = typeof client.getCliToken === "function" ? client.getCliToken() : "";

    const req = httpMod.request(
      {
        hostname: host,
        port,
        path: "/api/translator/console-logs/stream",
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
          "x-9r-cli-token": token,
        },
      },
      (res) => {
        if (res.statusCode >= 400) {
          console.error(`❌ Stream connection failed: HTTP ${res.statusCode}`);
          resolve(1);
          return;
        }

        let buffer = "";

        const handleLine = (line) => {
          if (!line || typeof line !== "string") return;
          if (filterLine(line, opts)) {
            console.log(colorizeLine(line));
          }
        };

        const handleEvent = (data) => {
          if (!data) return;
          try {
            const parsed = JSON.parse(data);
            if (parsed.type === "init" && Array.isArray(parsed.logs)) {
              const matched = parsed.logs.filter((l) => typeof l === "string" && filterLine(l, opts));
              const lines = opts.lines ? matched.slice(-opts.lines) : matched;
              for (const l of lines) console.log(colorizeLine(l));
            } else if (parsed.type === "line" && parsed.line) {
              handleLine(parsed.line);
            } else if (parsed.type === "lines" && Array.isArray(parsed.lines)) {
              for (const l of parsed.lines) handleLine(l);
            } else if (parsed.type === "clear") {
              // noop
            } else {
              handleLine(data);
            }
          } catch {
            handleLine(data);
          }
        };

        res.on("data", (chunk) => {
          buffer += chunk.toString("utf8");
          let delimMatch;
          while ((delimMatch = buffer.match(/\r?\n\r?\n/))) {
            const eventBlock = buffer.slice(0, delimMatch.index);
            buffer = buffer.slice(delimMatch.index + delimMatch[0].length);

            const rawLines = eventBlock.split(/\r?\n/);
            const dataLines = [];
            for (const l of rawLines) {
              if (l.startsWith(":")) continue;
              if (l.startsWith("data:")) {
                dataLines.push(l.slice(5).trimStart());
              }
            }
            if (dataLines.length > 0) {
              handleEvent(dataLines.join("\n"));
            }
          }
        });

        res.on("end", () => resolve(0));
        res.on("error", (err) => {
          if (opts.signal?.aborted || req.destroyed) return resolve(0);
          console.error(`❌ Stream error: ${err.message}`);
          resolve(1);
        });
      }
    );

    req.on("error", (err) => {
      if (opts.signal?.aborted || req.destroyed) return resolve(0);
      console.error(`❌ Failed to connect to 9router stream at ${host}:${port}: ${err.message}`);
      resolve(1);
    });

    req.end();

    if (opts.signal) {
      opts.signal.addEventListener(
        "abort",
        () => {
          try {
            req.destroy();
          } catch {}
          resolve(0);
        },
        { once: true }
      );
    }

    const cleanup = () => {
      try {
        req.destroy();
      } catch {}
      process.exit(0);
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  });
}

async function run(argv = [], extraOpts = {}) {
  let opts;
  try {
    opts = Object.assign(parseArgs(argv), extraOpts);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    return 1;
  }

  if (opts.help) {
    console.log(HELP.trim());
    return 0;
  }

  if (opts.follow) {
    return followLogs(opts);
  }

  return showHistory(opts);
}

module.exports = {
  run,
  __test__: {
    parseArgs,
    filterLine,
    colorizeLine,
    parseLogEntry,
    filterHistoryItem,
  },
};
