import { describe, it } from "node:test";
import assert from "node:assert/strict";

const LOG_LEVEL_COLORS = {
  LOG: "text-green-400",
  INFO: "text-blue-400",
  WARN: "text-yellow-400",
  ERROR: "text-red-400",
  DEBUG: "text-purple-400",
};

const ROUTING_TAGS = ["[COMBO MATCH]", "[WIRE ROUTE]", "[ROUTER]", "[DISPATCH]"];

function getLineColorClass(line) {
  if (typeof line === "string") {
    if (line.includes("[COMBO MATCH]")) {
      return "text-cyan-400 font-semibold";
    }
    if (line.includes("[WIRE ROUTE]")) {
      return "text-purple-400 font-semibold";
    }
  }
  let levelTag = null;
  const tags = typeof line === "string" ? line.match(/\[(\w+)\]/g) : null;
  if (tags) {
    for (const t of tags) {
      const tag = t.replace(/\[|\]/g, "").toUpperCase();
      if (LOG_LEVEL_COLORS[tag]) {
        levelTag = tag;
        break;
      }
    }
    if (!levelTag && tags[0]) {
      levelTag = tags[0].replace(/\[|\]/g, "").toUpperCase();
    }
  }
  return LOG_LEVEL_COLORS[levelTag] || "text-green-400";
}

function filterLogs(logs, { search = "", selectedTarget = "", routingOnly = false } = {}) {
  const q = search.trim().toLowerCase();
  const target = selectedTarget.trim().toLowerCase();

  return logs.filter((line) => {
    if (typeof line !== "string") return false;

    if (routingOnly) {
      const isRouting = ROUTING_TAGS.some((tag) => line.includes(tag));
      if (!isRouting) return false;
    }

    if (target && !line.toLowerCase().includes(target)) {
      return false;
    }

    if (q && !line.toLowerCase().includes(q)) {
      return false;
    }

    return true;
  });
}

function buildTargetOptions(combos, models) {
  const seenCombos = new Set();
  const comboOptions = [];
  for (const c of combos) {
    if (c?.name && !seenCombos.has(c.name)) {
      seenCombos.add(c.name);
      comboOptions.push({ value: c.name, label: `Combo: ${c.name}` });
    }
  }

  const seenModels = new Set();
  const modelOptions = [];
  for (const m of models) {
    if (m?.model && !seenModels.has(m.model)) {
      seenModels.add(m.model);
      modelOptions.push({ value: m.model, label: `Model: ${m.model}` });
    }
  }

  return [
    { value: "", label: "All Models / Combos" },
    ...comboOptions,
    ...modelOptions,
  ];
}

describe("Console Log Filtering and Colorization", () => {
  const sampleLogs = [
    "[2026-10-24 10:00:00] [INFO] Server started on port 20128",
    "[2026-10-24 10:00:01] [COMBO MATCH] matched combo smart-default for request claude-3-5",
    "[2026-10-24 10:00:02] [WIRE ROUTE] dispatching to upstream provider gpt-4o",
    "[2026-10-24 10:00:03] [ROUTER] selecting best route for gemini-1.5-pro",
    "[2026-10-24 10:00:04] [DISPATCH] worker dispatched to claude-3-5",
    "[2026-10-24 10:00:05] [WARN] Rate limit approaching for anthropic",
    "[2026-10-24 10:00:06] [ERROR] Upstream timeout on provider oc",
    "[2026-10-24 10:00:07] [DEBUG] Cache hit on token saver",
  ];

  it("colorizes lines correctly", () => {
    assert.equal(getLineColorClass(sampleLogs[1]), "text-cyan-400 font-semibold");
    assert.equal(getLineColorClass(sampleLogs[2]), "text-purple-400 font-semibold");
    assert.equal(getLineColorClass(sampleLogs[0]), "text-blue-400");
    assert.equal(getLineColorClass(sampleLogs[5]), "text-yellow-400");
    assert.equal(getLineColorClass(sampleLogs[6]), "text-red-400");
    assert.equal(getLineColorClass(sampleLogs[7]), "text-purple-400");
  });

  it("filters by case-insensitive search", () => {
    const result = filterLogs(sampleLogs, { search: "server" });
    assert.equal(result.length, 1);
    assert.ok(result[0].includes("Server started"));

    const result2 = filterLogs(sampleLogs, { search: "CLAUDE-3-5" });
    assert.equal(result2.length, 2);
  });

  it("filters by routingOnly toggle", () => {
    const routingLogs = filterLogs(sampleLogs, { routingOnly: true });
    assert.equal(routingLogs.length, 4);
    assert.ok(routingLogs.every((l) =>
      l.includes("[COMBO MATCH]") ||
      l.includes("[WIRE ROUTE]") ||
      l.includes("[ROUTER]") ||
      l.includes("[DISPATCH]")
    ));
  });

  it("filters by combo or model selection", () => {
    const resultCombo = filterLogs(sampleLogs, { selectedTarget: "smart-default" });
    assert.equal(resultCombo.length, 1);
    assert.ok(resultCombo[0].includes("smart-default"));

    const resultModel = filterLogs(sampleLogs, { selectedTarget: "gpt-4o" });
    assert.equal(resultModel.length, 1);
    assert.ok(resultModel[0].includes("gpt-4o"));

    const resultAll = filterLogs(sampleLogs, { selectedTarget: "" });
    assert.equal(resultAll.length, sampleLogs.length);
  });

  it("combines multiple filters correctly", () => {
    const result = filterLogs(sampleLogs, {
      routingOnly: true,
      selectedTarget: "claude-3-5",
      search: "matched",
    });
    assert.equal(result.length, 1);
    assert.ok(result[0].includes("[COMBO MATCH]"));
  });

  it("builds target options with deduplication and empty All option", () => {
    const combos = [{ name: "c1" }, { name: "c1" }, { name: "c2" }];
    const models = [{ model: "m1" }, { model: "m2" }, { model: "m1" }];
    const options = buildTargetOptions(combos, models);

    assert.deepEqual(options[0], { value: "", label: "All Models / Combos" });
    assert.deepEqual(options, [
      { value: "", label: "All Models / Combos" },
      { value: "c1", label: "Combo: c1" },
      { value: "c2", label: "Combo: c2" },
      { value: "m1", label: "Model: m1" },
      { value: "m2", label: "Model: m2" },
    ]);
  });
});
