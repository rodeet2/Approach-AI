require('dotenv').config();
const express = require('express');
const path = require('path');
const { randomUUID } = require('crypto');
const neo4j = require('neo4j-driver');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Neo4j connection ──────────────────────────────────────────────────────────
const driver = neo4j.driver(
    process.env.NEO4J_URI || 'bolt://localhost:7687',
    neo4j.auth.basic(
        process.env.NEO4J_USER || 'neo4j',
        process.env.NEO4J_PASSWORD || 'password'
    )
);

async function getSession() {
    // No explicit database — lets AuraDB use the instance default
    return driver.session();
}

// Verify connectivity on startup; warn but don't crash so the app still serves
// the frontend even if Neo4j isn't running yet.
driver.verifyConnectivity()
    .then(() => console.log('Neo4j connected ✓'))
    .catch(err => console.warn(`Neo4j not reachable (${err.message}) — running in degraded mode`));

// ── Relationship keyword parser ───────────────────────────────────────────────
// Supported pattern: "<New Task> after <Existing Task Name>"
// "after" must be preceded by actual task content (not at position 0).
// Returns { cleanTitle, blockedByTitle } — blockedByTitle may be null.
function parseBlocksRelationship(rawTitle) {
    // Require at least one non-whitespace char before " after "
    const match = rawTitle.match(/^(.+?)\s+after\s+(.+)$/i);
    if (!match) return { cleanTitle: rawTitle.trim(), blockedByTitle: null };

    return {
        cleanTitle:     match[1].trim(),
        blockedByTitle: match[2].trim(),
    };
}

// ── POST /add-task ────────────────────────────────────────────────────────────
// Body: { name: string }
// Creates a (:Task) node. If the name contains "after <Task Name>", also
// creates a [:BLOCKS] edge from the referenced task to this new one.
app.post('/add-task', async (req, res) => {
    const rawName = (req.body.name || '').trim();
    if (!rawName) {
        return res.status(400).json({ error: 'name is required' });
    }

    const { cleanTitle, blockedByTitle } = parseBlocksRelationship(rawName);
    const taskId = randomUUID();
    const createdAt = new Date().toISOString();

    const session = await getSession();
    try {
        // Always create the new Task node
        await session.run(
            `CREATE (t:Task {
                id: $id,
                title: $title,
                createdAt: $createdAt,
                priority: 0
            })`,
            { id: taskId, title: cleanTitle, createdAt }
        );

        let relationshipCreated = false;

        if (blockedByTitle) {
            // Find a task whose title matches (case-insensitive, trimmed)
            const findResult = await session.run(
                `MATCH (blocker:Task)
                 WHERE toLower(trim(blocker.title)) = toLower(trim($blockedByTitle))
                 RETURN blocker LIMIT 1`,
                { blockedByTitle }
            );

            if (findResult.records.length > 0) {
                await session.run(
                    `MATCH (blocker:Task {id: $blockerId})
                     MATCH (blocked:Task  {id: $blockedId})
                     MERGE (blocker)-[:BLOCKS]->(blocked)`,
                    {
                        blockerId: findResult.records[0].get('blocker').properties.id,
                        blockedId: taskId,
                    }
                );
                relationshipCreated = true;
            }
        }

        // Return the new task and whether a relationship was wired up
        res.status(201).json({
            task: { id: taskId, title: cleanTitle, createdAt },
            relationship: relationshipCreated
                ? { type: 'BLOCKS', blockedBy: blockedByTitle }
                : null,
        });
    } catch (err) {
        console.error('Neo4j error (POST /add-task):', err.message);
        res.status(500).json({ error: err.message });
    } finally {
        await session.close();
    }
});

// ── GET /graph ────────────────────────────────────────────────────────────────
// Returns all Task nodes and all relationships between them.
// Shape: { nodes: [...], relationships: [...] }
app.get('/graph', async (req, res) => {
    const session = await getSession();
    try {
        // Fetch every task
        const nodesResult = await session.run(
            `MATCH (t:Task) RETURN t ORDER BY t.createdAt DESC`
        );

        // Fetch every relationship between Task nodes
        const relsResult = await session.run(
            `MATCH (a:Task)-[r]->(b:Task) RETURN a.id AS source, type(r) AS type, b.id AS target`
        );

        const nodes = nodesResult.records.map(r => ({
            ...r.get('t').properties,
            labels: r.get('t').labels,
        }));

        const relationships = relsResult.records.map(r => ({
            source: r.get('source'),
            type:   r.get('type'),
            target: r.get('target'),
        }));

        // Attach connection counts to each node for convenience
        const connMap = {};
        relationships.forEach(rel => {
            connMap[rel.source] = (connMap[rel.source] || 0) + 1;
            connMap[rel.target] = (connMap[rel.target] || 0) + 1;
        });
        nodes.forEach(n => { n.connectionCount = connMap[n.id] || 0; });

        res.json({ nodes, relationships });
    } catch (err) {
        console.error('Neo4j error (GET /graph):', err.message);
        res.status(500).json({ error: err.message });
    } finally {
        await session.close();
    }
});

// ── DELETE /graph/:id ─────────────────────────────────────────────────────────
// Removes the Task node and all its relationships, then returns the updated graph.
app.delete('/graph/:id', async (req, res) => {
    const session = await getSession();
    try {
        await session.run(
            `MATCH (t:Task {id: $id}) DETACH DELETE t`,
            { id: req.params.id }
        );

        // Return the refreshed graph (same shape as GET /graph)
        const nodesResult = await session.run(
            `MATCH (t:Task) RETURN t ORDER BY t.createdAt DESC`
        );
        const relsResult = await session.run(
            `MATCH (a:Task)-[r]->(b:Task) RETURN a.id AS source, type(r) AS type, b.id AS target`
        );

        const nodes = nodesResult.records.map(r => ({
            ...r.get('t').properties,
            labels: r.get('t').labels,
        }));
        const relationships = relsResult.records.map(r => ({
            source: r.get('source'),
            type:   r.get('type'),
            target: r.get('target'),
        }));
        const connMap = {};
        relationships.forEach(rel => {
            connMap[rel.source] = (connMap[rel.source] || 0) + 1;
            connMap[rel.target] = (connMap[rel.target] || 0) + 1;
        });
        nodes.forEach(n => { n.connectionCount = connMap[n.id] || 0; });

        res.json({ nodes, relationships });
    } catch (err) {
        console.error('Neo4j error (DELETE /graph/:id):', err.message);
        res.status(500).json({ error: err.message });
    } finally {
        await session.close();
    }
});

// ── POST /prioritize ──────────────────────────────────────────────────────────
// Single Gemini call that does everything:
//   1. Builds the knowledge graph (edges + node enrichment)
//   2. Ranks all tasks using the graph structure
//   3. Returns a summary paragraph explaining the plan
app.post('/prioritize', async (req, res) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return res.status(503).json({ error: 'GEMINI_API_KEY is not set in .env' });
    }

    const session = await getSession();
    try {
        // ── Fetch all tasks ───────────────────────────────────────────────────
        const result = await session.run(
            `MATCH (t:Task) RETURN t.id AS id, t.title AS title ORDER BY t.createdAt ASC`
        );
        const tasks = result.records.map(r => ({
            id:    r.get('id'),
            title: r.get('title'),
        }));

        if (tasks.length === 0) {
            return res.json({ summary: '', rankings: [], nodes: [], relationships: [] });
        }

        // ── One Gemini call: build graph + rank + summarise ───────────────────
        const prompt = `You are an intelligent task planning assistant. Given a list of tasks, you will:
1. Identify relationships between tasks and build a knowledge graph
2. Rank all tasks by priority using that graph
3. Write a short overall summary

Tasks:
${tasks.map((t, i) => `${i + 1}. [${t.id}] ${t.title}`).join('\n')}

Return a single JSON object (no markdown, no text outside the JSON):
{
  "summary": "2-3 sentences explaining the overall structure and why tasks are ordered this way",
  "nodes": [
    { "taskId": "<id>", "category": "<one word: finance|health|work|home|learning|other>", "effort": "<low|medium|high>" }
  ],
  "edges": [
    { "from": "<id>", "to": "<id>", "type": "<BLOCKS|RELATED_TO|PART_OF>", "reason": "<one short sentence>" }
  ],
  "rankings": [
    { "taskId": "<id>", "finalRank": <1 = highest priority>, "reasoning": "<one short sentence>" }
  ]
}

Rules:
- BLOCKS: task A must be completed before task B can start (hard dependency)
- RELATED_TO: tasks belong to the same category or theme (grouping)
- PART_OF: task is a component or sub-step of another task
- Every task must appear in "nodes" and "rankings"
- Only create edges where there is a clear logical connection
- finalRank must be unique integers starting from 1`;

        const geminiRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
            }
        );
        if (!geminiRes.ok) {
            const errBody = await geminiRes.json();
            throw new Error(`Gemini API error ${geminiRes.status}: ${errBody?.error?.message}`);
        }
        const geminiData = await geminiRes.json();
        const raw = geminiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
        const jsonText = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

        let aiResult;
        try {
            aiResult = JSON.parse(jsonText);
        } catch {
            console.error('Gemini non-JSON response:', raw);
            return res.status(502).json({ error: 'Gemini returned invalid JSON', raw });
        }

        const { summary = '', nodes: aiNodes = [], edges = [], rankings = [] } = aiResult;

        // ── Write to Neo4j ────────────────────────────────────────────────────

        // 1. Clear all previous AI-generated edges (keeps manual "after" edges)
        await session.run(`MATCH ()-[r {source: 'ai'}]->() DELETE r`);

        // 2. Enrich nodes with category + effort
        if (aiNodes.length > 0) {
            await session.run(`
                UNWIND $nodes AS n
                MATCH (t:Task {id: n.taskId})
                SET t.category = n.category, t.effort = n.effort
            `, { nodes: aiNodes });
        }

        // 3. Create AI edges (dynamic rel type via template literal — safe: validated above)
        for (const edge of edges) {
            const relType = ['BLOCKS', 'RELATED_TO', 'PART_OF'].includes(edge.type)
                ? edge.type : 'RELATED_TO';
            try {
                await session.run(`
                    MATCH (a:Task {id: $from}), (b:Task {id: $to})
                    MERGE (a)-[r:\`${relType}\` {source: 'ai'}]->(b)
                    SET r.reason = $reason
                `, { from: edge.from, to: edge.to, reason: edge.reason || '' });
            } catch (edgeErr) {
                console.warn(`Skipping edge ${edge.from}-[${relType}]->${edge.to}:`, edgeErr.message);
            }
        }

        // 4. Write finalRank + per-task reasoning
        if (rankings.length > 0) {
            await session.run(`
                UNWIND $rankings AS r
                MATCH (t:Task {id: r.taskId})
                SET t.priority = r.finalRank, t.reasoning = r.reasoning
            `, { rankings });
        }

        // ── Return updated graph ──────────────────────────────────────────────
        const nodesResult = await session.run(`MATCH (t:Task) RETURN t ORDER BY t.priority ASC`);
        const relsResult  = await session.run(`
            MATCH (a:Task)-[r]->(b:Task)
            RETURN a.id AS source, type(r) AS type, b.id AS target,
                   r.reason AS reason, r.source AS relSource
        `);

        const updatedNodes = nodesResult.records.map(r => ({
            ...r.get('t').properties,
            labels: r.get('t').labels,
        }));
        const relationships = relsResult.records.map(r => ({
            source:    r.get('source'),
            type:      r.get('type'),
            target:    r.get('target'),
            reason:    r.get('reason'),
            relSource: r.get('relSource'),
        }));
        const connMap = {};
        relationships.forEach(rel => {
            connMap[rel.source] = (connMap[rel.source] || 0) + 1;
            connMap[rel.target] = (connMap[rel.target] || 0) + 1;
        });
        updatedNodes.forEach(n => { n.connectionCount = connMap[n.id] || 0; });

        res.json({ summary, rankings, nodes: updatedNodes, relationships });

    } catch (err) {
        console.error('Error in POST /prioritize:', err.message);
        res.status(500).json({ error: err.message });
    } finally {
        await session.close();
    }
});

// ── Legacy in-memory routes (keep working without Neo4j) ─────────────────────
// These back the existing frontend while Neo4j is being wired up.
let tasks = [];

function assignPriority(list) {
    return list.map((task, index) => ({
        ...task,
        priority: task.priority || Math.max(1, list.length - index),
    }));
}

app.get('/api/tasks', (req, res) => {
    const ranked = [...tasks].sort((a, b) => b.priority - a.priority);
    res.json(ranked);
});

app.post('/api/tasks', (req, res) => {
    const { title } = req.body;
    if (!title || !title.trim()) {
        return res.status(400).json({ error: 'Title is required' });
    }
    const newTask = {
        id: randomUUID(),
        title: title.trim(),
        createdAt: new Date().toISOString(),
        priority: tasks.length + 1,
        connections: [],
    };
    tasks.unshift(newTask);
    tasks = assignPriority(tasks);
    res.status(201).json([...tasks].sort((a, b) => b.priority - a.priority));
});

app.delete('/api/tasks/:id', (req, res) => {
    const before = tasks.length;
    tasks = tasks.filter(t => t.id !== req.params.id);
    if (tasks.length === before) {
        return res.status(404).json({ error: 'Task not found' });
    }
    tasks = assignPriority(tasks);
    res.json([...tasks].sort((a, b) => b.priority - a.priority));
});

// ── Start ─────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
    console.log(`Command Center running → http://localhost:${PORT}`);
});

// Clean up Neo4j driver on shutdown
process.on('SIGINT',  () => driver.close().finally(() => process.exit(0)));
process.on('SIGTERM', () => driver.close().finally(() => process.exit(0)));
