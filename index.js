import readline from "readline";
import { z } from "zod";
import admin from "firebase-admin";
import http from "http";

/* =========================
   Firebase Admin (Cloud Run)
========================= */

admin.initializeApp({
  storageBucket: "ai-students-85242.firebasestorage.app"
});

const bucket = admin.storage().bucket();

/* =========================
   Read curriculum from Storage
========================= */

async function getCurriculaFromStorage() {
  const file = bucket.file("curriculum_year_1_secondary.json");

  const [exists] = await file.exists();
  if (!exists) {
    throw new Error("Curriculum file not found in Firebase Storage");
  }

  const [contents] = await file.download();
  const jsonData = JSON.parse(contents.toString("utf-8"));

  return jsonData;
}

/* =========================
   MCP Core (stdio)
========================= */

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const tools = new Map();

function registerTool(name, definition, run) {
  tools.set(name, { definition, run });
}

function ok(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function err(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/* =========================
   Tool: get_curricula
========================= */

registerTool(
  "get_curricula",
  {
    name: "get_curricula",
    description: "Load curriculum JSON from Firebase Storage",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: []
    }
  },
  async () => {
    return await getCurriculaFromStorage();
  }
);

/* =========================
   MCP Loop
========================= */

rl.on("line", async (line) => {
  if (!line.trim()) return;

  let req;
  try {
    req = JSON.parse(line);
  } catch {
    console.log(JSON.stringify(err(null, -32700, "Invalid JSON")));
    return;
  }

  const { id, method, params } = req;

  try {
    if (method === "initialize") {
      console.log(
        JSON.stringify(
          ok(id, {
            protocolVersion: "0.1",
            serverInfo: {
              name: "study-planner-mcp",
              version: "1.0.0"
            }
          })
        )
      );
      return;
    }

    if (method === "tools/list") {
      console.log(
        JSON.stringify(
          ok(id, {
            tools: Array.from(tools.values()).map(t => t.definition)
          })
        )
      );
      return;
    }

    if (method === "tools/call") {
      const { name, arguments: args } = params || {};
      const tool = tools.get(name);

      if (!tool) {
        console.log(JSON.stringify(err(id, -32601, "Tool not found")));
        return;
      }

      const output = await tool.run(args || {});

      console.log(
        JSON.stringify(
          ok(id, {
            content: [
              {
                type: "json",
                json: output
              }
            ]
          })
        )
      );
      return;
    }

    console.log(JSON.stringify(err(id, -32601, "Method not found")));
  } catch (e) {
    console.log(JSON.stringify(err(id, -32000, e.message)));
  }
});

/* =========================
   Dummy HTTP Server (Cloud Run)
========================= */

const PORT = process.env.PORT || 8080;

http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("MCP Server is running\n");
}).listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
});
