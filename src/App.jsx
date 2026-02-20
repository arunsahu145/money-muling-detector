import { useState, useRef, useCallback, useEffect, useMemo } from "react";

// ═══════════════════════════════════════════════════════════
// MONEY MULING DETECTION ENGINE — Core Algorithms
// ═══════════════════════════════════════════════════════════

// ── CSV Parser ──
function parseCSV(text) {
  const lines = text.trim().split("\n");
  const headers = lines[0].split(",").map((h) => h.trim().replace(/"/g, ""));
  return lines
    .slice(1)
    .map((line) => {
      const values = [];
      let current = "";
      let inQuote = false;
      for (const ch of line) {
        if (ch === '"') {
          inQuote = !inQuote;
        } else if (ch === "," && !inQuote) {
          values.push(current.trim());
          current = "";
        } else {
          current += ch;
        }
      }
      values.push(current.trim());
      const obj = {};
      headers.forEach((h, i) => {
        obj[h] = values[i] || "";
      });
      obj.amount = parseFloat(obj.amount) || 0;
      obj.timestamp = new Date(obj.timestamp);
      return obj;
    })
    .filter((row) => row.sender_id && row.receiver_id && !isNaN(row.timestamp.getTime()));
}

// ── Graph Builder ──
function buildGraph(transactions) {
  const nodes = {};
  const edges = {};
  const adjacency = {};
  const reverseAdj = {};

  for (const txn of transactions) {
    const { sender_id: s, receiver_id: r, amount, timestamp } = txn;

    if (!nodes[s])
      nodes[s] = { id: s, totalSent: 0, totalReceived: 0, txnCount: 0 };
    if (!nodes[r])
      nodes[r] = { id: r, totalSent: 0, totalReceived: 0, txnCount: 0 };

    nodes[s].totalSent += amount;
    nodes[s].txnCount++;
    nodes[r].totalReceived += amount;
    nodes[r].txnCount++;

    const edgeKey = `${s}->${r}`;
    if (!edges[edgeKey]) {
      edges[edgeKey] = { source: s, target: r, totalAmount: 0, count: 0, timestamps: [] };
    }
    edges[edgeKey].totalAmount += amount;
    edges[edgeKey].count++;
    edges[edgeKey].timestamps.push(timestamp);

    if (!adjacency[s]) adjacency[s] = new Set();
    adjacency[s].add(r);
    if (!reverseAdj[r]) reverseAdj[r] = new Set();
    reverseAdj[r].add(s);
  }

  for (const id of Object.keys(nodes)) {
    nodes[id].inDegree = reverseAdj[id] ? reverseAdj[id].size : 0;
    nodes[id].outDegree = adjacency[id] ? adjacency[id].size : 0;
  }

  return { nodes, edges, adjacency, reverseAdj };
}

// ── Transaction Index — O(1) per-account lookup ──
// Eliminates repeated O(N) linear scans across 10k+ transactions
function buildTxnIndex(transactions) {
  const byAccount = {};
  const incoming = {};
  const outgoing = {};
  for (const txn of transactions) {
    const s = txn.sender_id, r = txn.receiver_id;
    if (!byAccount[s]) { byAccount[s] = []; incoming[s] = []; outgoing[s] = []; }
    if (!byAccount[r]) { byAccount[r] = []; incoming[r] = []; outgoing[r] = []; }
    byAccount[s].push(txn);
    byAccount[r].push(txn);
    outgoing[s].push(txn);
    incoming[r].push(txn);
  }
  return { byAccount, incoming, outgoing };
}

// ── Canonical Cycle Key (direction-preserving, rotation-invariant) ──
// For cycle [B,C,A], rotations are [B,C,A],[C,A,B],[A,B,C].
// We pick the lexicographically smallest rotation so every starting
// point for the same directed cycle hashes to the same key.
function getCanonicalCycle(path) {
  let minIdx = 0;
  for (let i = 1; i < path.length; i++) {
    if (path[i] < path[minIdx]) minIdx = i;
  }
  return [...path.slice(minIdx), ...path.slice(0, minIdx)].join(",");
}

// ── Cycle Detection — backtracking DFS, O(V·k^d) bounded ──
//
// Key improvements over the previous stack-based version:
//   • Backtracking: single shared path array + Set; no new Set/Array per hop
//   • Per-node iteration cap (10k) prevents hub-node explosion
//   • Deduplication via canonical rotation key (direction-preserving)
//   • Only starts from nodes with BOTH in- and out-edges (cycle prerequisite)
function detectCycles(adjacency, reverseAdj, nodeIds, maxCycles = 300) {
  const cycles = [];
  const seenKeys = new Set();
  const MAX_ITER_PER_NODE = 10_000;

  // Only nodes that can be part of a cycle need to be explored
  const candidates = nodeIds.filter(
    (id) => adjacency[id]?.size > 0 && reverseAdj[id]?.size > 0
  );

  for (const startNode of candidates) {
    if (cycles.length >= maxCycles) break;

    let nodeIter = 0;
    const path = [startNode];
    const onPath = new Set([startNode]);

    const dfs = (node) => {
      if (++nodeIter > MAX_ITER_PER_NODE || cycles.length >= maxCycles) return;
      const neighbors = adjacency[node];
      if (!neighbors) return;

      for (const next of neighbors) {
        if (next === startNode && path.length >= 3 && path.length <= 5) {
          // Closed cycle found — record with canonical key to deduplicate
          const key = getCanonicalCycle(path);
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            cycles.push([...path]);
          }
        } else if (!onPath.has(next) && path.length < 5) {
          path.push(next);
          onPath.add(next);
          dfs(next);
          path.pop();
          onPath.delete(next);
        }
      }
    };

    dfs(startNode);
  }
  return cycles;
}

// ── Temporal Clustering Score — O(N log N) sliding window ──
// Previous implementation was O(N²) via Array.filter inside a loop.
// Two-pointer on sorted timestamps is equivalent and linear after sort.
function temporalClustering(timestamps, windowHours = 72) {
  if (!timestamps || timestamps.length < 2) return 0;
  const times = timestamps
    .map((t) => (t instanceof Date ? t.getTime() : +t))
    .filter((t) => !isNaN(t))
    .sort((a, b) => a - b);
  if (times.length < 2) return 0;

  const windowMs = windowHours * 3_600_000;
  let best = 1;
  let right = 0;
  for (let left = 0; left < times.length; left++) {
    while (right < times.length - 1 && times[right + 1] <= times[left] + windowMs) {
      right++;
    }
    best = Math.max(best, right - left + 1);
  }
  return best / times.length;
}

// ── Cycle Time-Span Filter ──
// Legitimate "coincidental" cycles (e.g. business relationships) span
// months; real money-laundering cycles close within days.
// Returns false if ALL cycle edges span > maxSpanDays → likely benign.
function isCycleConcentrated(cycleNodes, edges, maxSpanDays = 45) {
  const times = [];
  for (let i = 0; i < cycleNodes.length; i++) {
    const s = cycleNodes[i];
    const t = cycleNodes[(i + 1) % cycleNodes.length];
    const edge = edges[`${s}->${t}`];
    if (edge?.timestamps) {
      for (const ts of edge.timestamps) {
        if (ts instanceof Date && !isNaN(ts.getTime())) times.push(ts.getTime());
      }
    }
  }
  if (times.length === 0) return true; // no timestamps → can't rule out, keep
  times.sort((a, b) => a - b);
  const spanDays = (times[times.length - 1] - times[0]) / 86_400_000;
  return spanDays <= maxSpanDays;
}

// ── False Positive Filters ──

function isLikelyMerchant(node, txnIndex) {
  const inTxns = txnIndex.incoming[node.id] || [];
  if (inTxns.length < 10) return false;
  const times = inTxns
    .map((t) => t.timestamp.getTime())
    .filter((t) => !isNaN(t))
    .sort((a, b) => a - b);
  if (times.length < 2) return false;
  const spanHours = (times[times.length - 1] - times[0]) / 3_600_000;
  const amounts = inTxns.map((t) => t.amount);
  const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
  const std = Math.sqrt(amounts.reduce((s, a) => s + (a - mean) ** 2, 0) / amounts.length);
  const cv = mean > 0 ? std / mean : 0;
  // High amount diversity from many sources over long periods
  if (spanHours > 720 && cv > 0.5) return true;
  // Merchant that also pays suppliers occasionally
  if (node.outDegree > 5 && spanHours > 168) return true;
  return false;
}

function isLikelyPayroll(node, txnIndex) {
  const outTxns = txnIndex.outgoing[node.id] || [];
  if (outTxns.length < 10) return false;
  const amounts = outTxns.map((t) => t.amount);
  const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
  const std = Math.sqrt(amounts.reduce((s, a) => s + (a - mean) ** 2, 0) / amounts.length);
  const cv = mean > 0 ? std / mean : 0;
  if (cv < 0.1) return true;
  const uniqueAmounts = new Set(amounts.map((a) => Math.round(a * 100)));
  if (uniqueAmounts.size <= 3 && outTxns.length > 15) return true;
  return false;
}

// NEW: Exchange / aggregator infrastructure — catches another common legitimate trap.
// These accounts have large balanced two-way flows (e.g. payment processors, PSPs).
function isLikelyExchange(node, txnIndex) {
  const inTxns = txnIndex.incoming[node.id] || [];
  const outTxns = txnIndex.outgoing[node.id] || [];
  if (inTxns.length < 20 || outTxns.length < 20) return false;
  const totalIn = inTxns.reduce((s, t) => s + t.amount, 0);
  const totalOut = outTxns.reduce((s, t) => s + t.amount, 0);
  const maxFlow = Math.max(totalIn, totalOut);
  if (maxFlow === 0) return false;
  // If flows are 70%+ balanced AND volume is very high → infrastructure
  const ratio = Math.min(totalIn, totalOut) / maxFlow;
  return ratio > 0.7 && inTxns.length + outTxns.length > 50;
}

// ── Smurfing Detection ──
function detectSmurfing(graph, txnIndex) {
  const rings = [];
  let counter = 1;
  const { nodes, reverseAdj, adjacency } = graph;

  for (const id of Object.keys(nodes)) {
    const node = nodes[id];

    if (node.inDegree >= 10) {
      if (isLikelyMerchant(node, txnIndex)) continue;
      if (isLikelyExchange(node, txnIndex)) continue;
      const preds = reverseAdj[id] ? [...reverseAdj[id]] : [];
      const inTxns = txnIndex.incoming[id] || [];
      const temporal = temporalClustering(inTxns.map((t) => t.timestamp));
      const riskScore = Math.min(100, 60 + node.inDegree * 1.5 + temporal * 20);
      rings.push({
        ring_id: `RING_FANIN_${String(counter).padStart(3, "0")}`,
        hub_id: id,
        intermediary_ids: [],
        member_accounts: [id, ...preds].sort(),
        pattern_type: "fan_in",
        risk_score: riskScore,
      });
      counter++;
    }

    if (node.outDegree >= 10) {
      if (isLikelyPayroll(node, txnIndex)) continue;
      if (isLikelyExchange(node, txnIndex)) continue;
      const succs = adjacency[id] ? [...adjacency[id]] : [];
      const outTxns = txnIndex.outgoing[id] || [];
      const temporal = temporalClustering(outTxns.map((t) => t.timestamp));
      const riskScore = Math.min(100, 60 + node.outDegree * 1.5 + temporal * 20);
      rings.push({
        ring_id: `RING_FANOUT_${String(counter).padStart(3, "0")}`,
        hub_id: id,
        intermediary_ids: [],
        member_accounts: [id, ...succs].sort(),
        pattern_type: "fan_out",
        risk_score: riskScore,
      });
      counter++;
    }
  }
  return rings;
}

// ── Shell Network Detection ──
function detectShellNetworks(graph) {
  const { nodes, adjacency, reverseAdj } = graph;
  const rings = [];
  let counter = 1;
  const visitedChains = new Set();

  const shellCandidates = new Set();
  for (const id of Object.keys(nodes)) {
    const totalDeg =
      (adjacency[id] ? adjacency[id].size : 0) +
      (reverseAdj[id] ? reverseAdj[id].size : 0);
    if (totalDeg >= 2 && totalDeg <= 3) shellCandidates.add(id);
  }

  // Cap candidates to prevent O(C³) explosion on large sparse graphs
  const shellArray = [...shellCandidates].slice(0, 500);

  for (const shellNode of shellArray) {
    const preds = reverseAdj[shellNode] ? [...reverseAdj[shellNode]].slice(0, 20) : [];
    const succs = adjacency[shellNode] ? [...adjacency[shellNode]].slice(0, 20) : [];

    for (const pred of preds) {
      for (const succ of succs) {
        if (pred === succ) continue;
        let chain = [pred, shellNode, succ];

        let current = succ;
        for (let d = 0; d < 3; d++) {
          const nextSuccs = adjacency[current]
            ? [...adjacency[current]].filter((n) => !chain.includes(n))
            : [];
          const shellNext = nextSuccs.find((n) => shellCandidates.has(n));
          const next = shellNext || nextSuccs[0];
          if (!next) break;
          chain.push(next);
          current = next;
        }

        if (chain.length >= 3) {
          const key = [...chain].sort().join(",");
          if (!visitedChains.has(key)) {
            visitedChains.add(key);
            const intermediaries = chain.slice(1, -1);
            const shellCount = intermediaries.filter((n) => shellCandidates.has(n)).length;
            const riskScore = Math.min(100, 50 + shellCount * 15 + chain.length * 5);
            rings.push({
              ring_id: `RING_SHELL_${String(counter).padStart(3, "0")}`,
              hub_id: null,
              intermediary_ids: intermediaries,
              member_accounts: [...chain].sort(),
              pattern_type: "layered_shell",
              risk_score: riskScore,
            });
            counter++;
          }
        }
      }
    }
  }
  return rings;
}

// ── Suspicion Scoring — max-then-bonus (prevents saturation) ──
//
// Previous system added score points per ring membership → accounts in
// multiple rings immediately hit 100 (meaningless). New system:
//   base  = strength of the single strongest evidence (max, not sum)
//   bonus = small increments for corroborating evidence
//
// Score guide:
//   50 = confirmed 3-node cycle member
//   42 = smurfing hub (aggregator / distributor)
//   32–40 = longer cycle
//   25 = shell intermediary
//   12 = smurfing satellite (peripheral; filtered if no corroboration)
//    5 = shell endpoint
// Bonuses (additive, capped):
//   +15 high temporal concentration (>75% txns in 72h window)
//    +8 moderate temporal concentration
//   +15 multi-cycle (diminishing returns per extra cycle)
//   +12 per additional pattern TYPE (cycle + smurfing = +12, etc.)
//    +8 extreme connectivity (degree > 25)
// Only accounts with finalScore ≥ 20 are flagged.
function computeSuspicionScores(graph, cycleRings, smurfRings, shellRings, txnIndex) {
  const scores = {};

  function init(id) {
    if (!scores[id])
      scores[id] = { baseScore: 0, patterns: new Set(), ring_id: "", cycleCount: 0, isHub: false };
  }

  // CYCLE SCORING
  for (const ring of cycleRings) {
    const len = ring.member_accounts.length;
    const base = len === 3 ? 50 : len === 4 ? 40 : 32;
    for (const acc of ring.member_accounts) {
      init(acc);
      scores[acc].baseScore = Math.max(scores[acc].baseScore, base);
      scores[acc].patterns.add(ring.pattern_type);
      scores[acc].cycleCount++;
      if (!scores[acc].ring_id) scores[acc].ring_id = ring.ring_id;
    }
  }

  // SMURFING SCORING — differentiate hub (42) vs satellites (12)
  for (const ring of smurfRings) {
    for (const acc of ring.member_accounts) {
      init(acc);
      const isHub = acc === ring.hub_id;
      const base = isHub ? 42 : 12;
      scores[acc].baseScore = Math.max(scores[acc].baseScore, base);
      if (isHub) scores[acc].isHub = true;
      scores[acc].patterns.add(ring.pattern_type);
      if (!scores[acc].ring_id) scores[acc].ring_id = ring.ring_id;
    }
  }

  // SHELL SCORING — differentiate intermediaries (25) vs endpoints (5)
  for (const ring of shellRings) {
    const interSet = new Set(ring.intermediary_ids || []);
    for (const acc of ring.member_accounts) {
      init(acc);
      const base = interSet.has(acc) ? 25 : 5;
      scores[acc].baseScore = Math.max(scores[acc].baseScore, base);
      scores[acc].patterns.add("layered_shell");
      if (!scores[acc].ring_id) scores[acc].ring_id = ring.ring_id;
    }
  }

  // BONUSES
  for (const accId of Object.keys(scores)) {
    const s = scores[accId];
    let bonus = 0;

    // Multi-cycle bonus (diminishing returns: 5, 10, 15 max)
    if (s.cycleCount > 1) bonus += Math.min(15, (s.cycleCount - 1) * 5);

    // Multi-pattern-TYPE bonus (cycle + fan = +12, all three = +24)
    const ptypes = new Set(
      [...s.patterns].map((p) =>
        p.includes("cycle") ? "cycle" : p.includes("fan") ? "fan" : "shell"
      )
    );
    if (ptypes.size > 1) bonus += (ptypes.size - 1) * 12;

    // Temporal concentration bonus (use pre-built index)
    const accTxns = txnIndex.byAccount[accId] || [];
    if (accTxns.length >= 2) {
      const temporal = temporalClustering(accTxns.map((t) => t.timestamp));
      if (temporal > 0.75) { bonus += 15; s.patterns.add("high_velocity"); }
      else if (temporal > 0.5) bonus += 8;
    }

    // High-connectivity bonus
    const node = graph.nodes[accId];
    if (node && node.inDegree + node.outDegree > 25) bonus += 8;

    s.finalScore = Math.min(100, s.baseScore + bonus);
  }

  // Minimum threshold: satellites with no corroborating signal stay silent
  return Object.entries(scores)
    .filter(([, data]) => data.finalScore >= 20)
    .map(([id, data]) => ({
      account_id: id,
      suspicion_score: data.finalScore,
      detected_patterns: [...data.patterns],
      ring_id: data.ring_id,
    }))
    .sort((a, b) => b.suspicion_score - a.suspicion_score);
}

// ── Main Detection Pipeline ──
function runDetection(csvText, filterHours = null) {
  const startTime = performance.now();
  let transactions = parseCSV(csvText);

  if (filterHours !== null && transactions.length > 0) {
    const validTimes = transactions.map((t) => t.timestamp.getTime()).filter((t) => !isNaN(t));
    const maxTs = Math.max(...validTimes);
    const cutoff = new Date(maxTs - filterHours * 3_600_000);
    transactions = transactions.filter((t) => t.timestamp >= cutoff);
  }

  const graph = buildGraph(transactions);
  // Build index once; all downstream functions use O(1) lookup instead of O(N) filter
  const txnIndex = buildTxnIndex(transactions);
  const nodeIds = Object.keys(graph.nodes);

  // ── Account classification (mutually exclusive, priority: exchange > merchant > payroll) ──
  let merchantCount = 0, payrollCount = 0, exchangeCount = 0;
  for (const id of nodeIds) {
    const node = graph.nodes[id];
    if (isLikelyExchange(node, txnIndex))       exchangeCount++;
    else if (isLikelyMerchant(node, txnIndex))  merchantCount++;
    else if (isLikelyPayroll(node, txnIndex))   payrollCount++;
  }

  // Cycle detection with backtracking DFS + iteration caps
  const rawCycles = detectCycles(graph.adjacency, graph.reverseAdj, nodeIds, 300);

  // Discard cycles whose edge timestamps span > 45 days (likely coincidental)
  const validCycles = rawCycles.filter((cycle) =>
    isCycleConcentrated(cycle, graph.edges, 45)
  );

  const cycleRings = validCycles.map((cycle, i) => {
    // Deterministic risk score based on temporal concentration of the cycle edges
    const edgeTimes = [];
    for (let k = 0; k < cycle.length; k++) {
      const edge = graph.edges[`${cycle[k]}->${cycle[(k + 1) % cycle.length]}`];
      if (edge?.timestamps) edgeTimes.push(...edge.timestamps);
    }
    const temporal = temporalClustering(edgeTimes);
    const base = cycle.length === 3 ? 90 : cycle.length === 4 ? 80 : 70;
    const riskScore = Math.min(100, base + temporal * 10);
    return {
      ring_id: `RING_CYCLE_${String(i + 1).padStart(3, "0")}`,
      hub_id: null,
      intermediary_ids: [],
      member_accounts: [...cycle].sort(),
      pattern_type: `cycle_length_${cycle.length}`,
      risk_score: riskScore,
    };
  });

  const smurfRings = detectSmurfing(graph, txnIndex);
  const shellRings = detectShellNetworks(graph);
  const allRings = [...cycleRings, ...smurfRings, ...shellRings];
  const suspicious = computeSuspicionScores(graph, cycleRings, smurfRings, shellRings, txnIndex);
  const processingTime = Math.round((performance.now() - startTime) / 10) / 100;

  // ── Global sequential ring renumbering ──
  // All rings across all pattern types get a single unified sequence:
  // RING_001, RING_002, … — matches the required output schema exactly.
  const ringIdRemap = {};
  allRings.forEach((ring, i) => {
    ringIdRemap[ring.ring_id] = `RING_${String(i + 1).padStart(3, "0")}`;
  });

  // Clean output rings: sequential IDs, simplified pattern_type, no internal fields
  const outputRings = allRings.map((ring) => ({
    ring_id: ringIdRemap[ring.ring_id],
    member_accounts: ring.member_accounts,
    pattern_type: ring.pattern_type.startsWith("cycle_length") ? "cycle" : ring.pattern_type,
    risk_score: ring.risk_score,
  }));

  // Remap ring_id in suspicious accounts to the new sequential IDs
  const outputSuspicious = suspicious.map((acc) => ({
    ...acc,
    ring_id: ringIdRemap[acc.ring_id] || acc.ring_id,
  }));

  const suspiciousIds = new Set(outputSuspicious.map((s) => s.account_id));
  const ringMemberMap = {};
  for (const ring of allRings) {
    for (const acc of ring.member_accounts) {
      if (!ringMemberMap[acc]) ringMemberMap[acc] = ringIdRemap[ring.ring_id];
    }
  }

  // ── Visualization node budget ──
  // For large graphs render at most MAX_VIZ_NODES nodes, prioritising:
  //   1. all suspicious accounts
  //   2. their immediate neighbours
  //   3. random fill from remaining nodes
  const MAX_VIZ_NODES = 400;
  let vizNodeIds = nodeIds;
  if (nodeIds.length > MAX_VIZ_NODES) {
    const neighborSet = new Set();
    for (const sid of suspiciousIds) {
      for (const n of (graph.adjacency[sid] || [])) neighborSet.add(n);
      for (const n of (graph.reverseAdj[sid] || [])) neighborSet.add(n);
    }
    const priority = [
      ...suspiciousIds,
      ...[...neighborSet].filter((n) => !suspiciousIds.has(n)),
    ];
    const remaining = nodeIds.filter((id) => !suspiciousIds.has(id) && !neighborSet.has(id));
    vizNodeIds = [...priority, ...remaining].slice(0, MAX_VIZ_NODES);
  }
  const vizNodeSet = new Set(vizNodeIds);

  const graphNodes = vizNodeIds.map((id) => {
    const node = graph.nodes[id];
    const suspData = suspicious.find((s) => s.account_id === id);
    return {
      id,
      suspicious: suspiciousIds.has(id),
      suspicion_score: suspData ? suspData.suspicion_score : 0,
      patterns: suspData ? suspData.detected_patterns : [],
      ring_id: ringMemberMap[id] || "",
      inDegree: node.inDegree,
      outDegree: node.outDegree,
      totalSent: Math.round(node.totalSent * 100) / 100,
      totalReceived: Math.round(node.totalReceived * 100) / 100,
    };
  });

  const graphEdges = Object.values(graph.edges)
    .filter((e) => vizNodeSet.has(e.source) && vizNodeSet.has(e.target))
    .map((e) => ({
      source: e.source,
      target: e.target,
      amount: Math.round(e.totalAmount * 100) / 100,
      count: e.count,
    }));

  return {
    result: {
      suspicious_accounts: outputSuspicious,
      fraud_rings: outputRings,
      summary: {
        total_accounts_analyzed: nodeIds.length,
        suspicious_accounts_flagged: outputSuspicious.length,
        fraud_rings_detected: outputRings.length,
        processing_time_seconds: processingTime,
        account_breakdown: {
          fraudulent: outputSuspicious.length,
          merchants: merchantCount,
          payroll_sources: payrollCount,
          exchanges: exchangeCount,
        },
      },
    },
    graphData: { nodes: graphNodes, edges: graphEdges },
  };
}

// ═══════════════════════════════════════════════════════════
// UI COMPONENTS
// ═══════════════════════════════════════════════════════════

const RING_COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4",
  "#8b5cf6", "#ec4899", "#f43f5e", "#14b8a6", "#a855f7",
];

function getRingColor(ringId, allRings) {
  const idx = allRings.findIndex((r) => r.ring_id === ringId);
  return RING_COLORS[idx % RING_COLORS.length] || "#ef4444";
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ── Force-Directed Graph (Canvas) ──
function GraphVisualization({ graphData, allRings, selectedNode, onSelectNode }) {
  const canvasRef = useRef(null);
  const animRef = useRef(null);
  const simRef = useRef({ nodes: [], edges: [], running: false });
  const interactionRef = useRef({
    dragging: null, isPanning: false, panStartX: 0, panStartY: 0,
    hoveredNode: null, panX: 0, panY: 0, zoom: 1,
  });

  // Stable refs so useEffect doesn't re-run when these change
  const stableRings = useRef(allRings);
  stableRings.current = allRings;
  const selectedNodeRef = useRef(selectedNode);
  selectedNodeRef.current = selectedNode;
  const onSelectNodeRef = useRef(onSelectNode);
  onSelectNodeRef.current = onSelectNode;

  const zoomAt = useCallback((factor) => {
    if (!canvasRef.current) return;
    const inter = interactionRef.current;
    const W = canvasRef.current.clientWidth;
    const H = canvasRef.current.clientHeight;
    const oldZoom = inter.zoom;
    const newZoom = Math.max(0.3, Math.min(3, oldZoom * factor));
    // Keep the canvas center fixed in world space
    const worldCX = (W / 2 - inter.panX) / oldZoom;
    const worldCY = (H / 2 - inter.panY) / oldZoom;
    inter.zoom = newZoom;
    inter.panX = W / 2 - worldCX * newZoom;
    inter.panY = H / 2 - worldCY * newZoom;
  }, []);

  useEffect(() => {
    if (!graphData || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const W = canvas.parentElement.clientWidth;
    const H = 560;
    canvas.width = W * 2;
    canvas.height = H * 2;
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.scale(2, 2);

    // Reset pan/zoom when a new graph loads
    interactionRef.current.panX = 0;
    interactionRef.current.panY = 0;
    interactionRef.current.zoom = 1;

    const simNodes = graphData.nodes.map((n) => ({
      ...n,
      x: W / 2 + (Math.random() - 0.5) * W * 0.7,
      y: H / 2 + (Math.random() - 0.5) * H * 0.7,
      vx: 0, vy: 0,
    }));
    const nodeMap = {};
    simNodes.forEach((n) => (nodeMap[n.id] = n));
    const simEdges = graphData.edges
      .map((e) => ({ ...e, sourceNode: nodeMap[e.source], targetNode: nodeMap[e.target] }))
      .filter((e) => e.sourceNode && e.targetNode);

    simRef.current = { nodes: simNodes, edges: simEdges, running: true, nodeMap };

    function simulate() {
      const { nodes: sn, edges: se } = simRef.current;
      // Repulsion between all node pairs
      for (let i = 0; i < sn.length; i++) {
        for (let j = i + 1; j < sn.length; j++) {
          let dx = sn[j].x - sn[i].x;
          let dy = sn[j].y - sn[i].y;
          let dist = Math.sqrt(dx * dx + dy * dy) || 1;
          let force = 3000 / (dist * dist);
          let fx = (dx / dist) * force;
          let fy = (dy / dist) * force;
          sn[i].vx -= fx; sn[i].vy -= fy;
          sn[j].vx += fx; sn[j].vy += fy;
        }
      }
      // Spring attraction along edges
      for (const e of se) {
        let dx = e.targetNode.x - e.sourceNode.x;
        let dy = e.targetNode.y - e.sourceNode.y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 1;
        let force = (dist - 130) * 0.01;
        let fx = (dx / dist) * force;
        let fy = (dy / dist) * force;
        e.sourceNode.vx += fx; e.sourceNode.vy += fy;
        e.targetNode.vx -= fx; e.targetNode.vy -= fy;
      }
      // Gravity toward center
      for (const n of sn) {
        n.vx += (W / 2 - n.x) * 0.001;
        n.vy += (H / 2 - n.y) * 0.001;
      }
      // Integrate + dampen
      for (const n of sn) {
        if (interactionRef.current.dragging === n.id) continue;
        n.vx *= 0.85; n.vy *= 0.85;
        n.x += n.vx * 0.3; n.y += n.vy * 0.3;
        n.x = Math.max(30, Math.min(W - 30, n.x));
        n.y = Math.max(30, Math.min(H - 30, n.y));
      }
    }

    function draw() {
      const { nodes: sn, edges: se } = simRef.current;
      const inter = interactionRef.current;
      ctx.clearRect(0, 0, W, H);
      ctx.save();
      ctx.translate(inter.panX, inter.panY);
      ctx.scale(inter.zoom, inter.zoom);

      for (const e of se) {
        const sx = e.sourceNode.x, sy = e.sourceNode.y;
        const tx = e.targetNode.x, ty = e.targetNode.y;
        const sourceRing = e.sourceNode.ring_id;
        const targetRing = e.targetNode.ring_id;
        const isRingEdge = sourceRing && targetRing && sourceRing === targetRing;

        ctx.beginPath();
        ctx.moveTo(sx, sy); ctx.lineTo(tx, ty);
        ctx.strokeStyle = isRingEdge ? getRingColor(sourceRing, stableRings.current) + "90" : "#334155";
        ctx.lineWidth = isRingEdge ? 2 : 0.8;
        ctx.stroke();

        const angle = Math.atan2(ty - sy, tx - sx);
        const nr = e.targetNode.suspicious ? 10 : 6;
        const ax = tx - Math.cos(angle) * (nr + 4);
        const ay = ty - Math.sin(angle) * (nr + 4);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(ax - Math.cos(angle - 0.3) * 8, ay - Math.sin(angle - 0.3) * 8);
        ctx.lineTo(ax - Math.cos(angle + 0.3) * 8, ay - Math.sin(angle + 0.3) * 8);
        ctx.closePath();
        ctx.fillStyle = isRingEdge ? getRingColor(sourceRing, stableRings.current) : "#475569";
        ctx.fill();
      }

      for (const n of sn) {
        const radius = n.suspicious ? 8 + n.suspicion_score / 15 : 5;
        const isHovered = inter.hoveredNode === n.id;
        const isSelected = selectedNodeRef.current === n.id;

        if (n.suspicious) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, radius + 6, 0, Math.PI * 2);
          const rc = getRingColor(n.ring_id, stableRings.current);
          ctx.fillStyle = rc + "25"; ctx.fill();
          ctx.strokeStyle = rc + "50"; ctx.lineWidth = 1; ctx.stroke();
        }

        ctx.beginPath();
        ctx.arc(n.x, n.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = n.suspicious ? getRingColor(n.ring_id, stableRings.current) : (isHovered ? "#94a3b8" : "#475569");
        ctx.fill();

        if (isSelected || isHovered) {
          ctx.strokeStyle = "#f8fafc"; ctx.lineWidth = 2; ctx.stroke();
        }

        if (isHovered || isSelected || n.suspicious) {
          ctx.font = `${n.suspicious ? "bold " : ""}10px monospace`;
          ctx.fillStyle = "#e2e8f0"; ctx.textAlign = "center";
          ctx.fillText(n.id, n.x, n.y - radius - 6);
        }
      }
      ctx.restore();

      if (inter.hoveredNode) {
        const hn = simRef.current.nodeMap[inter.hoveredNode];
        if (hn) {
          const tx2 = hn.x * inter.zoom + inter.panX;
          const ty2 = hn.y * inter.zoom + inter.panY;
          const boxW = 220;
          const bh = hn.suspicious ? 105 : 70;
          const bx = Math.min(tx2 + 15, W - boxW - 10);
          const by = Math.max(ty2 - 30, 10);

          ctx.fillStyle = "#0f172acc"; ctx.strokeStyle = "#334155"; ctx.lineWidth = 1;
          roundRect(ctx, bx, by, boxW, bh, 6); ctx.fill(); ctx.stroke();

          ctx.font = "bold 11px monospace";
          ctx.fillStyle = hn.suspicious ? getRingColor(hn.ring_id, stableRings.current) : "#e2e8f0";
          ctx.textAlign = "left";
          ctx.fillText(hn.id, bx + 10, by + 18);
          ctx.font = "10px monospace"; ctx.fillStyle = "#94a3b8";
          ctx.fillText(`In: ${hn.inDegree} | Out: ${hn.outDegree}`, bx + 10, by + 34);
          ctx.fillText(`Sent: $${hn.totalSent.toLocaleString()} | Recv: $${hn.totalReceived.toLocaleString()}`, bx + 10, by + 48);

          if (hn.suspicious) {
            ctx.fillStyle = getRingColor(hn.ring_id, stableRings.current);
            ctx.fillText(`Score: ${hn.suspicion_score} | ${hn.ring_id}`, bx + 10, by + 64);
            ctx.fillStyle = "#fbbf24";
            ctx.fillText(`Patterns: ${hn.patterns.join(", ")}`, bx + 10, by + 80);
            ctx.fillStyle = "#f87171"; ctx.font = "bold 10px monospace";
            ctx.fillText("⚠ SUSPICIOUS", bx + 10, by + 96);
          }
        }
      }
    }

    // Adaptive simulation iterations: fewer for large graphs to keep init fast
    const N = simNodes.length;
    const initIters = N > 200 ? 120 : N > 100 ? 250 : 500;
    for (let i = 0; i < initIters; i++) simulate();

    function loop() {
      draw();
      animRef.current = requestAnimationFrame(loop);
    }
    loop();

    function getNodeAt(mx, my) {
      const inter = interactionRef.current;
      const cx = (mx - inter.panX) / inter.zoom;
      const cy = (my - inter.panY) / inter.zoom;
      for (const n of simRef.current.nodes) {
        if (Math.hypot(n.x - cx, n.y - cy) < (n.suspicious ? 12 : 8)) return n;
      }
      return null;
    }

    const onMouseMove = (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const inter = interactionRef.current;
      if (inter.dragging) {
        const node = simRef.current.nodeMap[inter.dragging];
        if (node) {
          node.x = (mx - inter.panX) / inter.zoom;
          node.y = (my - inter.panY) / inter.zoom;
        }
      } else if (inter.isPanning) {
        inter.panX += mx - inter.panStartX;
        inter.panY += my - inter.panStartY;
        inter.panStartX = mx;
        inter.panStartY = my;
        canvas.style.cursor = "grabbing";
      } else {
        const node = getNodeAt(mx, my);
        inter.hoveredNode = node ? node.id : null;
        canvas.style.cursor = node ? "pointer" : "grab";
      }
    };

    const onMouseDown = (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const node = getNodeAt(mx, my);
      if (node) {
        interactionRef.current.dragging = node.id;
        onSelectNodeRef.current(node.id);
      } else {
        interactionRef.current.isPanning = true;
        interactionRef.current.panStartX = mx;
        interactionRef.current.panStartY = my;
        canvas.style.cursor = "grabbing";
      }
    };

    const onMouseUp = () => {
      interactionRef.current.dragging = null;
      interactionRef.current.isPanning = false;
      canvas.style.cursor = "grab";
    };

    canvas.style.cursor = "grab";
    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("mouseup", onMouseUp);

    return () => {
      cancelAnimationFrame(animRef.current);
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("mousedown", onMouseDown);
      canvas.removeEventListener("mouseup", onMouseUp);
    };
  }, [graphData]); // only re-init when graph data changes, not on selectedNode

  return (
    <div className="relative w-full rounded-lg overflow-hidden" style={{ background: "#0c1222", border: "1px solid #1e293b" }}>
      <canvas ref={canvasRef} className="w-full" style={{ height: 560 }} />
      <div className="absolute bottom-3 left-3 flex gap-1">
        <button
          onClick={() => zoomAt(1.2)}
          style={{ width: 28, height: 28, background: "#1e293b", border: "1px solid #334155", color: "#e2e8f0", borderRadius: 6, fontSize: 16, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}
          title="Zoom in"
        >+</button>
        <button
          onClick={() => zoomAt(1 / 1.2)}
          style={{ width: 28, height: 28, background: "#1e293b", border: "1px solid #334155", color: "#e2e8f0", borderRadius: 6, fontSize: 16, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}
          title="Zoom out"
        >−</button>
      </div>
      <div className="absolute bottom-3 right-3 text-xs" style={{ color: "#64748b" }}>
        Pan canvas • Drag nodes • Click for details
      </div>
    </div>
  );
}

// ── Account Breakdown Stats (below graph) ──
function AccountBreakdownStats({ summary }) {
  const total = summary.total_accounts_analyzed;
  if (!total || !summary.account_breakdown) return null;
  const count = summary.account_breakdown.fraudulent;
  const p = (count / total) * 100;

  return (
    <div className="rounded-lg p-4 mt-3 flex items-center gap-6" style={{ background: "#0a101f", border: "1px solid #1e293b" }}>
      <div>
        <p style={{ fontSize: 12, fontWeight: 600, color: "#64748b", marginBottom: 2, letterSpacing: "0.04em", textTransform: "uppercase" }}>
          🚨 Fraudulent Accounts
        </p>
        <span style={{ fontSize: 10, color: "#334155" }}>{count.toLocaleString()} of {total.toLocaleString()} accounts flagged</span>
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ height: 6, borderRadius: 3, background: "#1e293b" }}>
          <div style={{ height: 6, borderRadius: 3, width: `${Math.min(100, p)}%`, background: "#ef4444", transition: "width 0.4s ease" }} />
        </div>
      </div>
      <span style={{ fontSize: 20, fontWeight: 700, color: "#ef4444", fontFamily: "monospace", minWidth: 90, textAlign: "right" }}>
        {p.toFixed(4)}%
      </span>
    </div>
  );
}

// ── File Upload ──
function FileUpload({ onFileLoaded, loading }) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef(null);
  const handleFile = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => onFileLoaded(e.target.result, file.name);
    reader.readAsText(file);
  };

  return (
    <div
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files[0]); }}
      className="cursor-pointer transition-all duration-300"
      style={{
        border: `2px dashed ${dragOver ? "#f97316" : "#334155"}`,
        borderRadius: 12, padding: "48px 24px", textAlign: "center",
        background: dragOver ? "#1e293b" : "#0f172a",
      }}
    >
      <input ref={inputRef} type="file" accept=".csv" className="hidden" onChange={(e) => handleFile(e.target.files?.[0])} />
      <div style={{ fontSize: 48, marginBottom: 16 }}>{loading ? "⏳" : "📂"}</div>
      <p style={{ color: "#e2e8f0", fontSize: 18, fontWeight: 600, marginBottom: 8 }}>
        {loading ? "Analyzing transactions..." : "Upload Transaction CSV"}
      </p>
      <p style={{ color: "#64748b", fontSize: 14 }}>Drop your CSV file here or click to browse</p>
      <p style={{ color: "#475569", fontSize: 12, marginTop: 12 }}>
        Required columns: transaction_id, sender_id, receiver_id, amount, timestamp
      </p>
    </div>
  );
}

// ── Summary Cards ──
function SummaryCards({ summary }) {
  const cards = [
    { label: "Accounts Analyzed", value: summary.total_accounts_analyzed, icon: "🏦", color: "#3b82f6" },
    { label: "Suspicious Flagged", value: summary.suspicious_accounts_flagged, icon: "🚨", color: "#ef4444" },
    { label: "Fraud Rings", value: summary.fraud_rings_detected, icon: "🔗", color: "#f97316" },
    { label: "Processing Time", value: `${summary.processing_time_seconds}s`, icon: "⚡", color: "#22c55e" },
  ];
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
      {cards.map((c) => (
        <div key={c.label} className="rounded-lg p-4" style={{ background: "#0f172a", border: "1px solid #1e293b" }}>
          <div className="flex items-center gap-2 mb-1">
            <span style={{ fontSize: 20 }}>{c.icon}</span>
            <span style={{ color: "#64748b", fontSize: 12, fontWeight: 500 }}>{c.label}</span>
          </div>
          <div style={{ color: c.color, fontSize: 28, fontWeight: 700, fontFamily: "monospace" }}>
            {typeof c.value === "number" ? c.value.toLocaleString() : c.value}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Fraud Ring Table ──
function FraudRingTable({ rings }) {
  return (
    <div className="overflow-x-auto rounded-lg" style={{ border: "1px solid #1e293b" }}>
      <table className="w-full" style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ background: "#0f172a" }}>
            {["Ring ID", "Pattern", "Members", "Risk Score", "Member Accounts"].map((h) => (
              <th key={h} className="text-left p-3" style={{ color: "#94a3b8", fontSize: 12, fontWeight: 600, borderBottom: "1px solid #1e293b" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rings.map((ring, i) => (
            <tr key={ring.ring_id} style={{ background: i % 2 === 0 ? "#0a101f" : "#0f172a" }}>
              <td className="p-3" style={{ color: getRingColor(ring.ring_id, rings), fontFamily: "monospace", fontSize: 13, fontWeight: 600 }}>{ring.ring_id}</td>
              <td className="p-3">
                <span className="px-2 py-1 rounded text-xs font-medium" style={{
                  background: ring.pattern_type.includes("cycle") ? "#7c3aed20" : ring.pattern_type.includes("fan") ? "#f9731620" : "#06b6d420",
                  color: ring.pattern_type.includes("cycle") ? "#a78bfa" : ring.pattern_type.includes("fan") ? "#fb923c" : "#22d3ee",
                }}>{ring.pattern_type}</span>
              </td>
              <td className="p-3" style={{ color: "#e2e8f0", fontFamily: "monospace", fontSize: 14 }}>{ring.member_accounts.length}</td>
              <td className="p-3">
                <div className="flex items-center gap-2">
                  <div className="rounded-full h-2 flex-1" style={{ background: "#1e293b", maxWidth: 80 }}>
                    <div className="rounded-full h-2" style={{
                      width: `${ring.risk_score}%`,
                      background: ring.risk_score > 80 ? "#ef4444" : ring.risk_score > 60 ? "#f97316" : "#eab308",
                    }} />
                  </div>
                  <span style={{ color: "#e2e8f0", fontFamily: "monospace", fontSize: 13 }}>{ring.risk_score}</span>
                </div>
              </td>
              <td className="p-3" style={{ color: "#94a3b8", fontFamily: "monospace", fontSize: 11, maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis" }}>
                {ring.member_accounts.join(", ")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Suspicious Accounts List ──
function SuspiciousAccountsList({ accounts, onSelect }) {
  if (!accounts.length) return null;
  return (
    <div className="overflow-x-auto rounded-lg" style={{ border: "1px solid #1e293b", maxHeight: 400, overflowY: "auto" }}>
      <table className="w-full" style={{ borderCollapse: "collapse" }}>
        <thead style={{ position: "sticky", top: 0 }}>
          <tr style={{ background: "#0f172a" }}>
            {["Account ID", "Score", "Patterns", "Ring"].map((h) => (
              <th key={h} className="text-left p-3" style={{ color: "#94a3b8", fontSize: 12, fontWeight: 600, borderBottom: "1px solid #1e293b" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {accounts.map((acc, i) => (
            <tr key={acc.account_id} onClick={() => onSelect(acc.account_id)} className="cursor-pointer transition-colors"
              style={{ background: i % 2 === 0 ? "#0a101f" : "#0f172a" }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "#1e293b")}
              onMouseLeave={(e) => (e.currentTarget.style.background = i % 2 === 0 ? "#0a101f" : "#0f172a")}
            >
              <td className="p-3" style={{ color: "#f87171", fontFamily: "monospace", fontSize: 13, fontWeight: 600 }}>{acc.account_id}</td>
              <td className="p-3">
                <span className="px-2 py-1 rounded text-xs font-bold" style={{
                  background: acc.suspicion_score > 70 ? "#ef444430" : acc.suspicion_score > 40 ? "#f9731630" : "#eab30830",
                  color: acc.suspicion_score > 70 ? "#fca5a5" : acc.suspicion_score > 40 ? "#fdba74" : "#fde047",
                }}>{acc.suspicion_score}</span>
              </td>
              <td className="p-3">
                <div className="flex flex-wrap gap-1">
                  {acc.detected_patterns.map((p) => (
                    <span key={p} className="px-1.5 py-0.5 rounded text-xs" style={{ background: "#1e293b", color: "#94a3b8" }}>{p}</span>
                  ))}
                </div>
              </td>
              <td className="p-3" style={{ color: "#64748b", fontFamily: "monospace", fontSize: 12 }}>{acc.ring_id}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════

const TIME_FILTERS = [
  { id: "24h",  label: "24h",     hours: 24  },
  { id: "36h",  label: "36h",     hours: 36  },
  { id: "72h",  label: "72h",     hours: 72  },
  { id: "4d",   label: "4 days",  hours: 96  },
  { id: "all",  label: "All time",hours: null },
];

const PATTERN_FILTERS = [
  { id: "all",   label: "All Patterns",    icon: "🔍" },
  { id: "cycle", label: "Cycle Structures", icon: "🔄" },
  { id: "fan",   label: "Fan-in / Fan-out", icon: "🌊" },
  { id: "shell", label: "Shell Networks",   icon: "🐚" },
];

function ringMatchesPattern(ring, filter) {
  if (filter === "all") return true;
  // Ring IDs are renumbered to RING_NNN globally — match on pattern_type only,
  // which is guaranteed to be the canonical name ("cycle", "fan_in", "fan_out",
  // "layered_shell") set when outputRings is built.
  if (filter === "cycle") return ring.pattern_type.includes("cycle");
  if (filter === "fan")   return ring.pattern_type.includes("fan");
  if (filter === "shell") return ring.pattern_type.includes("layered") || ring.pattern_type.includes("shell");
  return true;
}

function accountMatchesPattern(acc, filter) {
  if (filter === "all") return true;
  // Ring IDs are renumbered to RING_NNN globally, so pattern matching
  // must use detected_patterns (which preserve the original pattern names).
  return acc.detected_patterns.some((p) => {
    if (filter === "cycle") return p.includes("cycle");
    if (filter === "fan")   return p.includes("fan");
    if (filter === "shell") return p.includes("layered") || p.includes("shell");
    return false;
  });
}

export default function App() {
  const [result, setResult] = useState(null);
  const [graphData, setGraphData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [fileName, setFileName] = useState("");
  const [selectedNode, setSelectedNode] = useState(null);
  const [activeTab, setActiveTab] = useState("graph");
  const [rawCSV, setRawCSV] = useState(null);
  const [timeFilter, setTimeFilter] = useState("all");
  const [patternFilter, setPatternFilter] = useState("all");

  const filteredRings = useMemo(() => {
    if (!result) return [];
    return result.fraud_rings.filter((r) => ringMatchesPattern(r, patternFilter));
  }, [result, patternFilter]);

  const filteredAccounts = useMemo(() => {
    if (!result) return [];
    return result.suspicious_accounts.filter((a) => accountMatchesPattern(a, patternFilter));
  }, [result, patternFilter]);

  const filteredGraphData = useMemo(() => {
    if (!graphData) return null;
    if (patternFilter === "all" || filteredRings.length === 0) return graphData;
    const memberIds = new Set(filteredRings.flatMap((r) => r.member_accounts));
    const nodes = graphData.nodes.filter((n) => memberIds.has(n.id));
    // Fallback: if no ring-member nodes made it into the visualisation budget
    // (e.g. the 400-node cap excluded them all), show the full graph rather than
    // an empty canvas.  This can happen with wide smurfing rings on large datasets.
    if (nodes.length === 0) return graphData;
    return {
      nodes,
      edges: graphData.edges.filter((e) => memberIds.has(e.source) && memberIds.has(e.target)),
    };
  }, [graphData, patternFilter, filteredRings]);

  // Re-run detection whenever the CSV or time filter changes.
  // setTimeout(0) lets React render the loading spinner before the main thread
  // blocks on computation — prevents the "frozen page" crash UX.
  useEffect(() => {
    if (!rawCSV) return;
    setLoading(true);
    const filterHours = TIME_FILTERS.find((f) => f.id === timeFilter)?.hours ?? null;
    const timer = setTimeout(() => {
      try {
        const { result: r, graphData: gd } = runDetection(rawCSV, filterHours);
        setResult(r);
        setGraphData(gd);
      } catch (err) {
        alert("Error processing CSV: " + err.message);
      } finally {
        setLoading(false);
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [rawCSV, timeFilter]);

  const handleFileLoaded = useCallback((csvText, name) => {
    setLoading(true);
    setFileName(name);
    setTimeFilter("all");
    setPatternFilter("all");
    setActiveTab("graph");
    setResult(null);
    setGraphData(null);
    setRawCSV(csvText);
  }, []);

  const downloadJSON = useCallback(() => {
    if (!result) return;
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "detection_results.json"; a.click();
    URL.revokeObjectURL(url);
  }, [result]);

  const resetAnalysis = () => {
    setResult(null); setGraphData(null); setFileName(""); setSelectedNode(null);
    setRawCSV(null); setTimeFilter("all"); setPatternFilter("all");
  };

  return (
    <div className="min-h-screen" style={{ background: "#040812", color: "#e2e8f0" }}>
      <header className="px-6 py-4" style={{ borderBottom: "1px solid #1e293b", background: "#060d1b" }}>
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div style={{ width: 36, height: 36, borderRadius: 8, background: "linear-gradient(135deg, #f97316, #ef4444)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>🔍</div>
            <div>
              <h1 style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.02em" }}>Money Muling Detection Engine</h1>
              <p style={{ fontSize: 11, color: "#64748b" }}>Graph-Based Financial Crime Detection</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {result && (
              <>
                <button onClick={downloadJSON} className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                  style={{ background: "#1e293b", color: "#e2e8f0", border: "1px solid #334155" }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "#334155")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "#1e293b")}
                >⬇ Download JSON</button>
                <button onClick={resetAnalysis} className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                  style={{ background: "#7c3aed20", color: "#a78bfa", border: "1px solid #7c3aed40" }}
                >↺ New Analysis</button>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-6">
        {!result && !loading ? (
          <div className="max-w-2xl mx-auto mt-16">
            <div className="text-center mb-8">
              <h2 style={{ fontSize: 32, fontWeight: 700, marginBottom: 8 }}>
                <span style={{ background: "linear-gradient(135deg, #f97316, #ef4444, #ec4899)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
                  Financial Forensics Engine
                </span>
              </h2>
              <p style={{ color: "#64748b", fontSize: 16 }}>Upload transaction data to detect money muling networks through graph analysis</p>
            </div>
            <FileUpload onFileLoaded={handleFileLoaded} loading={loading} />
            <div className="mt-8 grid grid-cols-3 gap-4">
              {[
                { icon: "🔄", title: "Cycle Detection", desc: "Circular fund routing (3-5 hops)" },
                { icon: "🌊", title: "Smurfing Analysis", desc: "Fan-in/fan-out with temporal clustering" },
                { icon: "🐚", title: "Shell Networks", desc: "Layered chains through dormant accounts" },
              ].map((f) => (
                <div key={f.title} className="rounded-lg p-4" style={{ background: "#0f172a", border: "1px solid #1e293b" }}>
                  <div style={{ fontSize: 24, marginBottom: 8 }}>{f.icon}</div>
                  <h3 style={{ fontSize: 14, fontWeight: 600, color: "#e2e8f0", marginBottom: 4 }}>{f.title}</h3>
                  <p style={{ fontSize: 12, color: "#64748b" }}>{f.desc}</p>
                </div>
              ))}
            </div>
          </div>
        ) : loading ? (
          <div className="max-w-2xl mx-auto mt-16">
            <div className="text-center mb-8">
              <div style={{ fontSize: 48, marginBottom: 16 }}>⏳</div>
              <h2 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8, color: "#e2e8f0" }}>
                Analyzing {fileName}
              </h2>
              <p style={{ color: "#64748b", fontSize: 14 }}>
                Running graph analysis, cycle detection, and smurfing detection…
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="flex items-center gap-2" style={{ color: "#64748b", fontSize: 13 }}>
              <span>📄 {fileName}</span><span>•</span>
              <span>Analyzed in {result.summary.processing_time_seconds}s</span>
            </div>

            <SummaryCards summary={result.summary} />

            {/* ── Filters row ── */}
            <div className="rounded-lg p-4 space-y-3" style={{ background: "#0a101f", border: "1px solid #1e293b" }}>
              {/* Time window */}
              <div className="flex items-center gap-3">
                <span style={{ color: "#64748b", fontSize: 12, fontWeight: 500, minWidth: 90 }}>Time window:</span>
                <div className="flex flex-wrap gap-1">
                  {TIME_FILTERS.map((f) => (
                    <button
                      key={f.id}
                      onClick={() => setTimeFilter(f.id)}
                      style={{
                        padding: "4px 12px", borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: "pointer",
                        border: timeFilter === f.id ? "1px solid #f97316" : "1px solid #334155",
                        background: timeFilter === f.id ? "#f9731620" : "transparent",
                        color: timeFilter === f.id ? "#f97316" : "#64748b",
                        transition: "all 0.15s",
                      }}
                    >{f.label}</button>
                  ))}
                </div>
              </div>
              {/* Pattern filter */}
              <div className="flex items-center gap-3">
                <span style={{ color: "#64748b", fontSize: 12, fontWeight: 500, minWidth: 90 }}>Pattern type:</span>
                <div className="flex flex-wrap gap-1">
                  {PATTERN_FILTERS.map((f) => (
                    <button
                      key={f.id}
                      onClick={() => setPatternFilter(f.id)}
                      style={{
                        padding: "4px 12px", borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: "pointer",
                        border: patternFilter === f.id ? "1px solid #8b5cf6" : "1px solid #334155",
                        background: patternFilter === f.id ? "#8b5cf620" : "transparent",
                        color: patternFilter === f.id ? "#a78bfa" : "#64748b",
                        transition: "all 0.15s",
                      }}
                    >{f.icon} {f.label}</button>
                  ))}
                </div>
              </div>
            </div>

            {/* ── Tab bar ── */}
            <div className="flex gap-1 p-1 rounded-lg" style={{ background: "#0f172a", display: "inline-flex" }}>
              {[
                { id: "graph",    label: "🕸 Graph View" },
                { id: "rings",    label: "🔗 Fraud Rings" },
                { id: "accounts", label: "🚨 Suspicious Accounts" },
              ].map((tab) => (
                <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                  className="px-4 py-2 rounded-md text-sm font-medium transition-all"
                  style={{ background: activeTab === tab.id ? "#1e293b" : "transparent", color: activeTab === tab.id ? "#e2e8f0" : "#64748b" }}
                >{tab.label}</button>
              ))}
            </div>

            {activeTab === "graph" && (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h2 style={{ fontSize: 16, fontWeight: 600 }}>Transaction Network Graph</h2>
                  <div className="flex items-center gap-4 text-xs" style={{ color: "#64748b" }}>
                    <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-full" style={{ background: "#475569" }} /> Normal</span>
                    <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-full" style={{ background: "#ef4444" }} /> Suspicious</span>
                  </div>
                </div>
                {filteredRings.length === 0 && patternFilter !== "all" ? (
                  <div className="flex flex-col items-center justify-center rounded-lg" style={{ background: "#0c1222", border: "1px solid #1e293b", height: 200, color: "#475569" }}>
                    <div style={{ fontSize: 36, marginBottom: 12 }}>🔍</div>
                    <p style={{ fontSize: 14, fontWeight: 600, color: "#64748b" }}>
                      No {PATTERN_FILTERS.find((f) => f.id === patternFilter)?.label} detected
                    </p>
                    <p style={{ fontSize: 12, marginTop: 4 }}>Try a different pattern type or time window</p>
                  </div>
                ) : (
                  <>
                    <GraphVisualization graphData={filteredGraphData} allRings={filteredRings} selectedNode={selectedNode} onSelectNode={setSelectedNode} />
                    <AccountBreakdownStats summary={result.summary} />
                  </>
                )}
              </div>
            )}

            {activeTab === "rings" && (
              <div>
                <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>
                  Detected Fraud Rings
                  {patternFilter !== "all" && (
                    <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, color: "#a78bfa" }}>
                      — {PATTERN_FILTERS.find((f) => f.id === patternFilter)?.label} ({filteredRings.length})
                    </span>
                  )}
                </h2>
                {filteredRings.length === 0 ? (
                  <div className="flex items-center justify-center rounded-lg p-8" style={{ background: "#0a101f", border: "1px solid #1e293b", color: "#475569", fontSize: 13 }}>
                    No {PATTERN_FILTERS.find((f) => f.id === patternFilter)?.label} rings detected in this time window
                  </div>
                ) : (
                  <FraudRingTable rings={filteredRings} />
                )}
              </div>
            )}

            {activeTab === "accounts" && (
              <div>
                <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>
                  Suspicious Accounts ({filteredAccounts.length})
                  {patternFilter !== "all" && (
                    <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, color: "#a78bfa" }}>
                      — {PATTERN_FILTERS.find((f) => f.id === patternFilter)?.label}
                    </span>
                  )}
                </h2>
                {filteredAccounts.length === 0 ? (
                  <div className="flex items-center justify-center rounded-lg p-8" style={{ background: "#0a101f", border: "1px solid #1e293b", color: "#475569", fontSize: 13 }}>
                    No suspicious accounts match the current filters
                  </div>
                ) : (
                  <SuspiciousAccountsList accounts={filteredAccounts} onSelect={setSelectedNode} />
                )}
              </div>
            )}
          </div>
        )}
      </main>

      <footer className="mt-12 px-6 py-4" style={{ borderTop: "1px solid #1e293b" }}>
        <div className="max-w-7xl mx-auto text-center" style={{ color: "#334155", fontSize: 12 }}>
          Graph-Based Financial Crime Detection
        </div>
      </footer>
    </div>
  );
}
