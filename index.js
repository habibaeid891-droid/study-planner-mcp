import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const app = express();
app.use(express.json({ type: "*/*" }));

/**
 * MCP Server
 */
const server = new McpServer({
  name: "study-planner-mcp",
  version: "1.0.0",
});

/**
 * Tool
 */
server.tool(
  "get_curriculum",
  { yearId: z.string() },
  async ({ yearId }) => {
    return {
      content: [{ type: "text", text: "ok" }],
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
  res.status(200).send("MCP is running");
});

app.all("/mcp", async (req, res) => {
  await transport.handleRequest(req, res, req.body);
});

/**
 * 🚀 IMPORTANT PART
 */
const port = Number(process.env.PORT || 8080);

app.listen(port, "0.0.0.0", () => {
  console.log(`🚀 HTTP listening on ${port}`);

  // ⬅️ connect AFTER listen
  server.connect(transport).then(() => {
    console.log("✅ MCP connected");
  });
});
