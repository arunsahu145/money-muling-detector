# 🕵️ FraudnetX

**Graph-Based Financial Crime Detection Engine** | Graph Theory Track

A web-based Financial Forensics Engine that processes transaction CSV data and exposes money muling networks through graph analysis, interactive visualization, and downloadable JSON reports.

---

## 🌐 Live Demo

**[→ https://money-muling-detector-sjw2.vercel.app/](https://money-muling-detector-sjw2.vercel.app/)**

Upload any transaction CSV and get instant fraud ring detection with interactive graph visualization. No login required.

---

## 🛠 Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Frontend Framework | React 18 + Vite 5 | Single-page application with fast HMR |
| Styling | Tailwind CSS 3 | Dark-theme responsive UI with utility classes |
| Graph Visualization | HTML5 Canvas 2D (custom force-directed) | Interactive directed graph with hover/click/drag/zoom |
| Detection Engine | JavaScript (client-side) | Cycle detection, smurfing analysis, shell network detection |
| CSV Parsing | Custom JavaScript parser | Handles quoted fields, validates column schema |
| Deployment | Vercel | Zero-config static hosting with auto-deploy from GitHub |

**Why client-side?** All processing runs entirely in the browser. For datasets up to 10K transactions, analysis completes in under 5 seconds. No backend server needed — no cold starts, no CORS issues, and no data ever leaves the user's browser, ensuring complete data privacy.

---

## 🏗 System Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                      BROWSER (Client-Side)                    │
│                                                              │
│  ┌─────────────┐    ┌──────────────────────────────────────┐│
│  │  CSV Upload   │───▶│      Detection Engine (App.jsx)      ││
│  │  (drag/drop)  │    │                                      ││
│  └─────────────┘    │  Step 1: parseCSV()                    ││
│                      │     → Validate columns & parse rows    ││
│                      │     → Convert timestamps & amounts     ││
│                      │                                      ││
│                      │  Step 2: buildGraph()                  ││
│                      │     → Directed adjacency list          ││
│                      │     → Reverse adjacency list           ││
│                      │     → Node metadata (degree, totals)   ││
│                      │     → Edge metadata (amount, count)    ││
│                      │                                      ││
│                      │  Step 3: detectCycles()                ││
│                      │     → DFS-based cycle enumeration      ││
│                      │     → Length 3-5 with deduplication    ││
│                      │                                      ││
│                      │  Step 4: detectSmurfing()              ││
│                      │     → Fan-in (in-degree >= 10)         ││
│                      │     → Fan-out (out-degree >= 10)       ││
│                      │     → 72-hour temporal clustering      ││
│                      │     → Merchant & Payroll filters       ││
│                      │                                      ││
│                      │  Step 5: detectShellNetworks()         ││
│                      │     → Identify low-degree (2-3) nodes  ││
│                      │     → Trace chains through shells      ││
│                      │     → Extend up to depth 5             ││
│                      │                                      ││
│                      │  Step 6: computeSuspicionScores()      ││
│                      │     → Weighted composite score 0-100   ││
│                      │     → Sort descending                  ││
│                      └──────────┬───────────────────────────┘│
│                                 │                              │
│                      ┌──────────▼───────────────────────────┐│
│                      │         Output / UI Layer              ││
│                      │                                      ││
│                      │  • Interactive force-directed graph    ││
│                      │    (Canvas 2D with physics simulation) ││
│                      │  • Summary dashboard (4 metric cards)  ││
│                      │  • Fraud ring detail table             ││
│                      │  • Suspicious accounts list            ││
│                      │  • One-click JSON download             ││
│                      └──────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────┘
```

**Data Flow Pipeline:**

```
CSV File Upload
      │
      ▼
  parseCSV() ──→ Validate & parse 5 required columns
      │
      ▼
  buildGraph() ──→ Directed graph with adjacency lists + metadata
      │
      ├──→ detectCycles() ──────────→ Circular fund routing (3-5 hops)
      ├──→ detectSmurfing() ────────→ Fan-in/Fan-out with temporal analysis
      └──→ detectShellNetworks() ──→ Layered chains through dormant accounts
              │
              ▼
      computeSuspicionScores() ──→ Weighted 0-100 composite score
              │
              ▼
      Render UI + Generate JSON ──→ Graph + Tables + Downloadable Report
```

---

## 🧮 Algorithm Approach & Complexity Analysis

### 1. Cycle Detection (Circular Fund Routing)

**What it detects:** Money flowing in loops to obscure origin — e.g., A → B → C → A

**Algorithm:** Iterative DFS from every node in the graph. For each start node, we explore all directed paths up to maximum length 5. When a path returns to the start node and the path length is between 3 and 5, we record it as a cycle. To prevent duplicate detection of the same ring, we deduplicate using sorted node-set keys stored in a HashSet.

**Implementation:** `detectCycles()` in `src/App.jsx`

**Complexity:** O(V × (V+E) × d) where V = vertices, E = edges, d = max depth (5). The depth cap at 5 makes this tractable for large graphs. For sparse financial transaction graphs, this is effectively **O(V × E)**.

**Why DFS over Johnson's Algorithm?** For cycles capped at length 5, iterative DFS with a visited set is simpler to implement, easier to debug, and performs comparably to Johnson's algorithm. The bounded depth prevents combinatorial explosion.

---

### 2. Smurfing Detection (Fan-in / Fan-out)

**What it detects:** Structuring patterns where many small deposits aggregate into one account (fan-in) or one account disperses to many recipients (fan-out) to avoid reporting thresholds.

**Algorithm:**
1. During graph construction, compute **in-degree** and **out-degree** for every node.
2. Flag nodes with **in-degree >= 10** as fan-in candidates and **out-degree >= 10** as fan-out candidates.
3. For each candidate, compute **temporal clustering score**: slide a 72-hour window across sorted transaction timestamps. For each position, calculate the fraction of transactions within that window. The maximum fraction across all positions becomes the clustering score (0.0 to 1.0). Higher clustering = more suspicious.
4. Apply **false positive filters** before flagging (merchant and payroll heuristics — see below).
5. Group the hub account with all its connected accounts into a fraud ring.

**Implementation:** `detectSmurfing()`, `temporalClustering()`, `isLikelyMerchant()`, `isLikelyPayroll()` in `src/App.jsx`

**Complexity:** O(V + E) for degree computation during graph construction. O(k²) per flagged node for temporal sliding window analysis, where k = number of transactions involving that node. Total: **O(V + E + F × k²)** where F = number of flagged candidates.

---

### 3. Layered Shell Network Detection

**What it detects:** Money passing through intermediary "shell" accounts that exist only to add layers of separation. These accounts have minimal transaction history (just 2-3 total transactions).

**Algorithm:**
1. Scan all nodes to identify **shell candidates** — nodes with total degree (in-degree + out-degree) of exactly 2 or 3.
2. For each shell candidate, enumerate all predecessor → shell → successor chains.
3. **Extend chains** forward through additional shell nodes, up to maximum depth 5, preferring shell candidates at each step.
4. Chains of length >= 3 are recorded as shell network rings.
5. Deduplicate by sorted member sets to avoid counting the same network twice.

**Implementation:** `detectShellNetworks()` in `src/App.jsx`

**Complexity:** O(S × P × d) where S = number of shell candidates, P = average predecessor/successor count per shell, d = max chain depth (5). Shell candidates are typically a **small subset** of all nodes (low-activity accounts), making this efficient in practice: **O(S × d²)**.

---

### False Positive Control

The problem statement warns about hidden traps — legitimate high-volume accounts designed to catch naive algorithms. FraudnetX implements two statistical heuristic filters:

**Merchant Filter** (`isLikelyMerchant()`):
- Triggers when a high-in-degree node receives transactions **spread over 30+ days** (720+ hours) with **varied amounts** (coefficient of variation > 0.5).
- Also checks for **bidirectional flow** — merchants both receive payments from customers and send payments to suppliers (out-degree > 5 and span > 7 days).
- **If matched → node is NOT flagged**, preventing false positives on e-commerce stores, restaurants, utility companies, etc.

**Payroll Filter** (`isLikelyPayroll()`):
- Triggers when a high-out-degree node sends **very consistent amounts** (coefficient of variation < 0.1 — meaning amounts are nearly identical).
- Also checks if only **1-3 distinct amounts** are used across 15+ outgoing transactions (salary tiers).
- **If matched → node is NOT flagged**, preventing false positives on payroll processors, HR departments, recurring subscription services, etc.

---

## 📊 Suspicion Score Methodology

Each flagged account receives a **composite suspicion score (0–100)** calculated by summing weighted signals from multiple independent detection factors:

| Detection Factor | Points | Trigger Condition |
|---|---|---|
| **Cycle Membership** | **+30** | Account is part of a detected cycle (length 3, 4, or 5) |
| **Fan-in / Fan-out** | **+25** | Account is in a smurfing ring (in-degree >= 10 or out-degree >= 10) |
| **Temporal Clustering** | **+20** | >70% of account's transactions fall within a single 72-hour window |
| **Shell Intermediary** | **+15** | Account lies on a layered shell chain with low-activity intermediaries |
| **Transaction Velocity** | **+10** | Account has total degree > 20 (unusually high transaction volume) |

**Final Score = min(100, sum of all applicable factors)**

**Key properties:**
- **Scores stack:** An account appearing in both a cycle and a smurfing ring scores 30 + 25 = 55 (before temporal/velocity bonuses), making multi-pattern accounts rank higher.
- **Sorted descending:** The `suspicious_accounts` array in the JSON output is always sorted highest score first, so the most suspicious accounts appear at the top.
- **Capped at 100:** No score exceeds 100 regardless of how many patterns match.
- **Zero for clean accounts:** Accounts not detected in any pattern receive no score and are excluded from the suspicious list entirely.

**Implementation:** `computeSuspicionScores()` in `src/App.jsx`

---

## 🚀 Installation & Setup

### Prerequisites

- **Node.js 18+** and **npm** installed ([download](https://nodejs.org/))
- **Python 3.8+** (only needed to generate test data)
- **Git** for version control

### Step 1: Clone the Repository

```bash
git clone https://github.com/arunsahu145/FraudnetX.git
cd FraudnetX
```

### Step 2: Install Dependencies

```bash
npm install
```

### Step 3: Generate Test Data (optional — test_data.csv is already included)

```bash
python generate_test_data.py
```

This creates `test_data.csv` with 230 transactions containing:
- 2 cycle rings (length 3 and length 4)
- 1 fan-in ring (12 senders → 1 hub)
- 1 fan-out ring (1 hub → 12 receivers)
- 1 shell chain (3 intermediary accounts)
- 1 merchant trap (should NOT be flagged)
- 1 payroll trap (should NOT be flagged)
- 100 random background noise transactions

### Step 4: Run Development Server

```bash
npm run dev
```

Open **http://localhost:5173** in your browser.

### Step 5: Build for Production

```bash
npm run build
```

Production-ready output goes to the `dist/` folder.

### Step 6: Deploy to Vercel

```bash
npm i -g vercel
vercel login
vercel --prod
```

Or connect your GitHub repo at [vercel.com](https://vercel.com) for automatic deployments on every push.

---

## 📖 Usage Instructions

1. **Open the application** at [https://money-muling-detector-umber.vercel.app/](https://money-muling-detector-umber.vercel.app/) or your local dev server.

2. **Upload a CSV file** by dragging it onto the upload zone or clicking to browse. The CSV must contain these exact columns:

   | Column | Type | Example |
   |---|---|---|
   | `transaction_id` | String | `TXN_00001` |
   | `sender_id` | String | `ACC_001` |
   | `receiver_id` | String | `ACC_002` |
   | `amount` | Float | `5000.00` |
   | `timestamp` | DateTime | `2025-06-01 10:00:00` |

3. **Explore results** using the three tabs:

   - **🕸 Graph View** — Interactive force-directed network graph. Colored/larger nodes = suspicious (color-coded by ring). Grey/smaller nodes = normal. **Hover** any node for a detailed tooltip showing degree, amounts, score, patterns, and ring assignment. **Drag** nodes to rearrange the layout. **Scroll** to zoom in/out.

   - **🔗 Fraud Rings** — Summary table showing each detected ring with Ring ID, Pattern Type (cycle/fan_in/fan_out/layered_shell), Member Count, Risk Score (with visual progress bar), and comma-separated Member Account IDs.

   - **🚨 Suspicious Accounts** — Scrollable table of all flagged accounts sorted by suspicion score (highest first). Shows account ID, score badge (color-coded by severity), detected patterns as tags, and ring assignment. **Click** any row to highlight that account on the graph.

4. **Download JSON report** — Click the **"⬇ Download JSON"** button in the header. The output file `detection_results.json` matches the exact hackathon-required schema with `suspicious_accounts`, `fraud_rings`, and `summary` objects.

5. **Analyze another dataset** — Click **"↺ New Analysis"** to reset and upload a different CSV file.

---

## 📁 Project Structure

```
FraudnetX/
│
├── src/
│   ├── App.jsx              ← Detection engine + all UI components (~850 lines)
│   │                           Detection Functions:
│   │                           • parseCSV() — CSV parsing & validation
│   │                           • buildGraph() — Directed graph construction
│   │                           • detectCycles() — DFS cycle finder (length 3-5)
│   │                           • detectSmurfing() — Fan-in/fan-out + temporal
│   │                           • detectShellNetworks() — Shell chain detection
│   │                           • isLikelyMerchant() — Merchant false positive filter
│   │                           • isLikelyPayroll() — Payroll false positive filter
│   │                           • computeSuspicionScores() — Weighted 0-100 scoring
│   │                           • runDetection() — Main pipeline orchestrator
│   │                           UI Components:
│   │                           • GraphVisualization — Canvas force-directed graph
│   │                           • FileUpload — Drag-and-drop CSV uploader
│   │                           • SummaryCards — 4 metric dashboard cards
│   │                           • FraudRingTable — Ring details table
│   │                           • SuspiciousAccountsList — Flagged accounts table
│   │                           • App — Main shell with header, tabs, footer
│   │
│   ├── index.css            ← Tailwind directives + global styles + scrollbar
│   └── main.jsx             ← React entry point (mounts <App /> into #root)
│
├── .gitignore               ← Ignores node_modules/, dist/, .env, logs
├── generate_test_data.py    ← Python test data generator with known patterns + traps
├── index.html               ← HTML entry point with meta tags
├── package.json             ← Dependencies & npm scripts (dev/build/preview)
├── postcss.config.js        ← PostCSS: tailwindcss + autoprefixer
├── README.md                ← This documentation file
├── tailwind.config.js       ← Tailwind content scan paths
├── test_data.csv            ← Sample dataset (230 transactions)
└── vite.config.js           ← Vite bundler config with React plugin
```

---

## ⚠ Known Limitations

1. **Cycle detection on dense graphs:** For graphs with >50K edges, DFS-based cycle enumeration may slow down. The depth cap of 5 mitigates this, but extremely interconnected networks could approach the 30-second processing limit. A potential improvement would be Johnson's algorithm with early termination.

2. **Browser memory constraints:** Very large datasets (>100K transactions) may hit browser memory limits since the entire graph structure is held in JavaScript objects. For production-scale deployment, a server-side implementation using Python's NetworkX library would handle larger datasets.

3. **Statistical false positive heuristics:** The merchant and payroll filters rely on coefficient of variation thresholds and time-span analysis. Edge cases exist — a merchant with bursty seasonal sales may not be filtered, or an unusual payroll schedule might be incorrectly excluded.

4. **Fixed detection thresholds:** Fan-in/fan-out threshold is fixed at 10 connections, temporal window at 72 hours, and shell degree at 2-3. Production systems would benefit from configurable or adaptive thresholds tuned per financial institution's transaction patterns.

5. **No data persistence:** Results exist only in the current browser session. Users must download the JSON report to save results. Refreshing the page or closing the tab clears all analysis data.

6. **Single-file processing:** The engine analyzes one CSV file per session. There is no incremental analysis or streaming mode for continuous real-time transaction monitoring.

7. **Cycle risk score variation:** Cycle ring risk scores include a small random component (0-5 points) for visual differentiation between rings of identical length. This means cycle scores may vary slightly between successive runs on the same dataset.

---

## 👥 Team Members

| Name | Role | 
|---|---|
| **Shreya Basker** | Team Leader |
| **Arun Kumar Sahu** | Team Member |
| **Krishnabh Kalita** | Team Member |
| **Nyssa Bansal** | Team Member |

---

## 📋 JSON Output Format

The downloadable JSON follows the exact schema required by the hackathon:

```json
{
  "suspicious_accounts": [
    {
      "account_id": "ACC_001",
      "suspicion_score": 50,
      "detected_patterns": ["cycle_length_3", "high_velocity"],
      "ring_id": "RING_CYCLE_001"
    }
  ],
  "fraud_rings": [
    {
      "ring_id": "RING_CYCLE_001",
      "member_accounts": ["ACC_001", "ACC_002", "ACC_003"],
      "pattern_type": "cycle_length_3",
      "risk_score": 92.3
    }
  ],
  "summary": {
    "total_accounts_analyzed": 178,
    "suspicious_accounts_flagged": 35,
    "fraud_rings_detected": 5,
    "processing_time_seconds": 0.12
  }
}
```

**Field specifications:**
- `suspicious_accounts` — Array sorted by `suspicion_score` descending. Each entry has `account_id` (String), `suspicion_score` (Float 0-100), `detected_patterns` (Array of Strings), `ring_id` (String).
- `fraud_rings` — Array of detected rings. Pattern types include: `cycle_length_3`, `cycle_length_4`, `cycle_length_5`, `fan_in`, `fan_out`, `layered_shell`.
- `summary` — Aggregate metrics including actual measured `processing_time_seconds`.

---



