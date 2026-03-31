# Approach AI

A smart task manager that uses **Gemini AI** to understand your tasks, build a knowledge graph of how they connect, and tell you exactly what to work on first — and what to batch together.

---

## What it does

You type in your tasks. When you click **Prioritize**, the app:

1. Sends all your tasks to **Gemini 2.5 Flash**
2. Gemini analyses them and builds a knowledge graph — figuring out what depends on what, what's related, and what can be done together
3. The graph structure is saved to **Neo4j AuraDB** as real graph nodes and relationships
4. The UI updates instantly with:
   - A **ranked priority list** showing what to tackle first, with a one-sentence reason for each task
   - A **visual knowledge graph** showing how your tasks connect to each other
   - A **summary paragraph** from Gemini explaining the overall plan

---

## The two panels

### The Priority Path (left)
Tasks ordered from most to least important. Each card shows:
- Its rank number (1 = do this first)
- An AI explanation of why it landed at that position
- A category tag and effort level after Prioritize runs

### The Knowledge Graph (right)
Your tasks as bubbles with colour-coded connections between them:

| Colour | Connection type | What it means |
|--------|----------------|---------------|
| Amber solid arrow | `BLOCKS` | Task A must be done before Task B can start |
| Indigo dashed line | `RELATED TO` | Tasks belong to the same category or theme |
| Purple dashed line | `DONE TOGETHER` | Tasks that can be efficiently batched in one go (e.g. "buy milk" and "pick up dry cleaning" — same errand run) |

Each bubble also shows a small **category dot** (colour-coded: finance, health, work, home, learning) and an **effort chip** (low / medium / high).

---

## How to add tasks

Type any task in the input bar and press **Add Task**.

**Manual dependencies:** If you type `"X after Y"` in the task name, a `BLOCKS` connection is automatically created in Neo4j from Y to X. For example:

> `Deploy app after Set up database`

This stores "Deploy app" as the task and links it so "Set up database" must be completed first. These manual edges survive every re-prioritization.

**Try the demo:** Click **Load Demo Tasks** below the input bar to instantly add 10 varied sample tasks across finance, health, work, and home. Then click **Prioritize** to see the full AI graph in action.

---

## Getting started

### 1. Install dependencies
```bash
npm install
```

### 2. Set up your credentials in `.env`

```
NEO4J_URI=neo4j+s://xxxxxxxx.databases.neo4j.io
NEO4J_USER=your-username
NEO4J_PASSWORD=your-password
PORT=3000
GEMINI_API_KEY=AIza...
```

**Neo4j** — Free cloud database at [console.neo4j.io](https://console.neo4j.io). Copy the Connection URI, username, and password from your instance.

**Gemini** — Free API key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). Billing must be enabled on your Google Cloud project — you won't be charged within free tier limits (1,500 requests/day).

### 3. Start the server
```bash
npm start
```

### 4. Open the app
[http://localhost:3000](http://localhost:3000)

---

## How the AI graph works

Every time you click Prioritize, Gemini does three things in a single call:

**Step 1 — Categorise:** Each task gets a category (finance, health, work, home, learning) and an effort level (low, medium, high) based on what the title means.

**Step 2 — Build the graph:** Gemini looks at all tasks together and creates relationships:
- `BLOCKS` — hard dependency, one must finish before the other starts
- `RELATED_TO` — same domain or theme, grouped together
- `DONE_TOGETHER` — tasks that can be batched efficiently in one outing or session

**Step 3 — Rank:** Using the graph it just built, Gemini ranks everything. Tasks that unblock others rank highest. Batched tasks are scheduled together. A short summary explains the overall plan.

All results are written back to Neo4j. Previous AI edges are cleared first so the graph is always fresh.

---

## Project structure

```
approach-ai/
├── public/
│   └── index.html           ← Full frontend (HTML + CSS + JS)
├── pipelines/
│   └── prioritize.pipe.json ← RocketRide AI pipeline definition
├── server.js                ← Express server + all API routes
├── .env                     ← Credentials (never commit this)
└── package.json
```

---

## API routes

| Method | Route | What it does |
|--------|-------|-------------|
| `GET` | `/graph` | Returns all tasks and their connections |
| `POST` | `/add-task` | Adds a new task — body: `{ name: "..." }` |
| `DELETE` | `/graph/:id` | Removes a task and all its relationships |
| `POST` | `/prioritize` | Full AI run: builds graph, ranks tasks, writes to Neo4j, returns summary |

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Server | Node.js + Express |
| Database | Neo4j AuraDB |
| AI | Google Gemini 2.5 Flash |
| Frontend | HTML + CSS + JavaScript (no frameworks) |
| Fonts | Inter + JetBrains Mono |

---

## What's coming next

- **RocketRide AI** pipeline integration — the `pipelines/prioritize.pipe.json` file is already prepared for a direct Neo4j ↔ LLM pipeline in the RocketRide visual editor
- Task completion tracking
- Export the graph as a shareable visual plan
