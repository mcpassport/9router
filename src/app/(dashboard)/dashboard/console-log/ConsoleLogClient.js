"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { Card, Button, Input, Select, Toggle, Badge } from "@/shared/components";
import { CONSOLE_LOG_CONFIG } from "@/shared/constants/config";

const LOG_LEVEL_COLORS = {
  LOG: "text-green-400",
  INFO: "text-blue-400",
  WARN: "text-yellow-400",
  ERROR: "text-red-400",
  DEBUG: "text-purple-400",
};

const ROUTING_TAGS = ["[COMBO MATCH]", "[WIRE ROUTE]", "[ROUTER]", "[DISPATCH]"];

function colorLine(line) {
  if (typeof line === "string") {
    if (line.includes("[COMBO MATCH]")) {
      return <span className="text-cyan-400 font-semibold">{line}</span>;
    }
    if (line.includes("[WIRE ROUTE]")) {
      return <span className="text-purple-400 font-semibold">{line}</span>;
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
  const color = LOG_LEVEL_COLORS[levelTag] || "text-green-400";
  return <span className={color}>{line}</span>;
}

export default function ConsoleLogClient() {
  const [logs, setLogs] = useState([]);
  const [connected, setConnected] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedTarget, setSelectedTarget] = useState("");
  const [routingOnly, setRoutingOnly] = useState(false);
  const [combos, setCombos] = useState([]);
  const [models, setModels] = useState([]);
  const logRef = useRef(null);

  const handleClear = async () => {
    try {
      await fetch("/api/translator/console-logs", { method: "DELETE" });
      // UI cleared via SSE "clear" event
    } catch (err) {
      console.error("Failed to clear console logs:", err);
    }
  };

  useEffect(() => {
    let mounted = true;
    const fetchOptions = async () => {
      try {
        const [combosRes, modelsRes] = await Promise.all([
          fetch("/api/combos"),
          fetch("/api/models"),
        ]);
        if (combosRes.ok) {
          const combosData = await combosRes.json();
          if (mounted && Array.isArray(combosData?.combos)) {
            setCombos(combosData.combos);
          }
        }
        if (modelsRes.ok) {
          const modelsData = await modelsRes.json();
          if (mounted && Array.isArray(modelsData?.models)) {
            setModels(modelsData.models);
          }
        }
      } catch (err) {
        console.error("Failed to fetch combos or models:", err);
      }
    };
    fetchOptions();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const es = new EventSource("/api/translator/console-logs/stream");

    es.onopen = () => setConnected(true);

    es.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "init") {
        setLogs(msg.logs.slice(-CONSOLE_LOG_CONFIG.maxLines));
      } else if (msg.type === "line") {
        setLogs((prev) => {
          const next = [...prev, msg.line];
          return next.length > CONSOLE_LOG_CONFIG.maxLines ? next.slice(-CONSOLE_LOG_CONFIG.maxLines) : next;
        });
      } else if (msg.type === "lines") {
        setLogs((prev) => {
          const next = [...prev, ...msg.lines];
          return next.length > CONSOLE_LOG_CONFIG.maxLines ? next.slice(-CONSOLE_LOG_CONFIG.maxLines) : next;
        });
      } else if (msg.type === "clear") {
        setLogs([]);
      }
    };

    es.onerror = () => setConnected(false);

    return () => es.close();
  }, []);

  const targetOptions = useMemo(() => {
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
  }, [combos, models]);

  const filteredLogs = useMemo(() => {
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
  }, [logs, routingOnly, selectedTarget, search]);

  // Auto-scroll to bottom on new logs or filter change
  useEffect(() => {
    if (!logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [filteredLogs]);

  return (
    <div>
      <Card padding="none" className="overflow-hidden">
        <div className="flex flex-col gap-3 p-4 border-b border-border-subtle lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-1 flex-wrap items-center gap-3">
            <Input
              placeholder="Filter logs..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              icon="search"
              className="w-full sm:w-64"
            />
            <Select
              value={selectedTarget}
              onChange={(e) => setSelectedTarget(e.target.value)}
              options={targetOptions}
              placeholder="All Models / Combos"
              className="w-full sm:w-60"
            />
            <Toggle
              label="Routing only"
              checked={routingOnly}
              onChange={setRoutingOnly}
              size="sm"
            />
          </div>
          <div className="flex items-center gap-3 self-end lg:self-auto">
            <Badge variant="default">
              {`${filteredLogs.length} / ${logs.length}`}
            </Badge>
            <Button size="sm" variant="outline" icon="delete" onClick={handleClear}>
              Clear
            </Button>
          </div>
        </div>
        <div
          ref={logRef}
          className="bg-black p-4 text-xs font-mono h-[calc(100vh-220px)] overflow-y-auto"
        >
          {filteredLogs.length === 0 ? (
            <span className="text-text-muted">
              {logs.length === 0 ? "No console logs yet." : "No matching logs."}
            </span>
          ) : (
            <div className="space-y-0.5">
              {filteredLogs.map((line, i) => (
                <div key={i}>{colorLine(line)}</div>
              ))}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
