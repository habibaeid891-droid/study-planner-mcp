import express from "express";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/dist/server/streamableHttp.js";


const app = express();
app.use(express.json());

/**
 * MCP Server
 */
const server = new McpServer({
  name: "study-planner-mcp",
  version: "1.0.0",
});

server.tool(
  "get_curriculum",
  {
    yearId: z.string(),
  },
  async ({ yearId }) => {
    if (yearId !== "year_1_secondary") {
      return {
        isError: true,
        content: [{ type: "text", text: "Year not supported yet" }],
      };
    }

    return {
      content: [
        {
          type: "json",
          data: {
            yearId: "year_1_secondary",
            yearName: "الصف الأول الثانوي",
            subjects: [],
          },
        },
      ],
    };
  }
);

/**
 * Transport
 */
const transport = new StreamableHTTPServerTransport({
  endpoint: "/mcp",
});

/**
 * Routes
 */
app.get("/", (_req, res) => {
  res.status(200).send("Study Planner MCP is running ✅");
});

app.all("/mcp", async (req, res) => {
  await transport.handleRequest(req, res, req.body);
});

/**
 * Start Express FIRST
 */
const port = Number(process.env.PORT || 8080);

app.listen(port, "0.0.0.0", () => {
  console.log(`🚀 HTTP server listening on ${port}`);
});

/**
 * Then connect MCP (NON blocking)
 */
server.connect(transport).then(() => {
  console.log("✅ MCP connected");
}).catch(err => {
  console.error("❌ MCP connection error", err);
});



