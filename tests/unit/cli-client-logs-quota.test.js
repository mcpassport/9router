import assert from "node:assert/strict";
import http from "node:http";
import { describe, it, afterEach } from "node:test";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const client = require("../../cli/src/cli/api/client.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "../../cli/cli.js");

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

const closeServer = (server) => new Promise((resolve) => server.close(resolve));

describe("cli/src/cli/api/client.js - logs & quota", () => {
  let serverInfo;

  afterEach(async () => {
    if (serverInfo?.server) {
      await closeServer(serverInfo.server);
      serverInfo = null;
    }
  });

  it("exports getRecentLogs, getUsageStats, streamConsoleLogs", () => {
    assert.strictEqual(typeof client.getRecentLogs, "function");
    assert.strictEqual(typeof client.getUsageStats, "function");
    assert.strictEqual(typeof client.streamConsoleLogs, "function");
  });

  it("getRecentLogs makes GET to /api/usage/logs with cli token", async () => {
    let requestedPath = null;
    let requestedMethod = null;
    let tokenHeader = null;

    serverInfo = await startServer((req, res) => {
      requestedPath = req.url;
      requestedMethod = req.method;
      tokenHeader = req.headers["x-9r-cli-token"];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([{ id: "log-1", model: "claude-3-5-sonnet" }]));
    });

    client.configure({ host: "127.0.0.1", port: serverInfo.port, protocol: "http:" });
    const result = await client.getRecentLogs();

    assert.strictEqual(requestedMethod, "GET");
    assert.strictEqual(requestedPath, "/api/usage/logs");
    assert.ok(typeof tokenHeader === "string");
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data.length, 1);
    assert.strictEqual(result.data[0].id, "log-1");
  });

  it("getUsageStats makes GET to /api/usage/stats with encoded period", async () => {
    let requestedPath = null;

    serverInfo = await startServer((req, res) => {
      requestedPath = req.url;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ totalRequests: 42, totalTokens: 1000 }));
    });

    client.configure({ host: "127.0.0.1", port: serverInfo.port, protocol: "http:" });

    const defaultResult = await client.getUsageStats();
    assert.strictEqual(requestedPath, "/api/usage/stats?period=all");
    assert.strictEqual(defaultResult.success, true);
    assert.strictEqual(defaultResult.data.totalRequests, 42);

    const periodResult = await client.getUsageStats("7d");
    assert.strictEqual(requestedPath, "/api/usage/stats?period=7d");
    assert.strictEqual(periodResult.success, true);
  });

  it("streamConsoleLogs streams SSE messages and parses line/lines/init formats", async () => {
    let requestedPath = null;
    let acceptHeader = null;
    let serverRes = null;

    serverInfo = await startServer((req, res) => {
      requestedPath = req.url;
      acceptHeader = req.headers.accept;
      serverRes = res;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
    });

    client.configure({ host: "127.0.0.1", port: serverInfo.port, protocol: "http:" });

    const receivedLines = [];
    let streamEnded = false;

    const stream = client.streamConsoleLogs(
      (line) => receivedLines.push(line),
      (err) => { throw err; },
      () => { streamEnded = true; }
    );

    assert.strictEqual(typeof stream.close, "function");

    // Wait for connection
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(requestedPath, "/api/translator/console-logs/stream");
    assert.strictEqual(acceptHeader, "text/event-stream");

    // Send init event
    serverRes.write(`data: ${JSON.stringify({ type: "init", logs: ["init line 1", "init line 2"] })}\n\n`);
    // Send single line event
    serverRes.write(`data: ${JSON.stringify({ type: "line", line: "single line" })}\n\n`);
    // Send batch lines event
    serverRes.write(`data: ${JSON.stringify({ type: "lines", lines: ["batch 1", "batch 2"] })}\n\n`);
    // Send raw text event
    serverRes.write(`data: plain text line\n\n`);

    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.deepStrictEqual(receivedLines, [
      "init line 1",
      "init line 2",
      "single line",
      "batch 1",
      "batch 2",
      "plain text line",
    ]);

    serverRes.end();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(streamEnded, true);

    stream.close();
  });

  it("streamConsoleLogs calls onError when response status >= 400", async () => {
    serverInfo = await startServer((req, res) => {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
    });

    client.configure({ host: "127.0.0.1", port: serverInfo.port, protocol: "http:" });

    let capturedError = null;
    const stream = client.streamConsoleLogs(
      () => {},
      (err) => { capturedError = err; }
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(capturedError);
    assert.match(capturedError.message, /HTTP 403/);
    stream.close();
  });

  it("streamConsoleLogs close() destroys the request", async () => {
    let clientDisconnected = false;

    serverInfo = await startServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      req.on("close", () => {
        clientDisconnected = true;
      });
    });

    client.configure({ host: "127.0.0.1", port: serverInfo.port, protocol: "http:" });

    const stream = client.streamConsoleLogs(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));

    stream.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(clientDisconnected, true);
  });
});

describe("cli/cli.js - help output", () => {
  it("includes quota and logs commands in --help", () => {
    const output = execFileSync(process.execPath, [CLI_PATH, "--help"], { encoding: "utf8" });
    assert.match(output, /quota \[options\]\s+Check token usage, costs, and request stats/);
    assert.match(output, /logs \[options\]\s+View or follow recent gateway logs with filters/);
  });
});
