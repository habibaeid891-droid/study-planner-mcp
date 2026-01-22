import http from "http";
import admin from "firebase-admin";

/* =========================
   Firebase Admin (Cloud Run)
========================= */

admin.initializeApp({
  storageBucket: "ai-students-85242.firebasestorage.app"
});

const bucket = admin.storage().bucket();

/* =========================
   Read JSON from Firebase Storage
========================= */

async function readJsonFromStorage(filePath) {
  const file = bucket.file(filePath);

  const [exists] = await file.exists();
  if (!exists) {
    throw new Error(`File not found: ${filePath}`);
  }

  const [contents] = await file.download();
  return JSON.parse(contents.toString("utf-8"));
}

/* =========================
   MCP Tools
========================= */

const tools = {
  get_curricula: {
    definition: {
      name: "get_curricula",
      description: "Read curriculum JSON from Firebase Storage",
      inputSchema: {
        type: "object",
        properties: {},
        required: []
      }
    },
    async run() {
      return await readJsonFromStorage("curriculum_year_1_secondary.json");
    }
  }
};

/* =========================
   HTTP JSON-RPC Server
========================= */

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("MCP Server is running");
    return;
  }

  let body = "";
  req.on("data", chunk => (body += chunk));

  req.on("end", async () => {
    try {
      const { id, method, params } = JSON.parse(body);

      if (method === "initialize") {
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "0.1",
            serverInfo: { name: "curriculum-mcp", version: "1.0.0" }
          }
        }));
        return;
      }

      if (method === "tools/list") {
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { tools: Object.values(tools).map(t => t.definition) }
        }));
        return;
      }

      if (method === "tools/call") {
        const tool = tools[params?.name];
        if (!tool) throw new Error("Tool not found");

        const output = await tool.run(params?.arguments || {});
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "json", json: output }]
          }
        }));
        return;
      }

      throw new Error("Unknown method");
    } catch (e) {
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message: e.message }
      }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`✅ MCP Server listening on port ${PORT}`);
});
