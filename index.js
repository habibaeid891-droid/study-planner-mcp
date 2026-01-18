import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const app = express();
app.use(express.json());

/**
 * 1️⃣ MCP Server
 edit
 */
const server = new McpServer({
  name: "study-planner-curriculum",
  version: "1.0.0",
});

/**
 * 2️⃣ Tool: get_curriculum
 */
server.tool(
  "get_curriculum",
  {
    yearId: z.string().describe("Academic year id مثل: year_1_secondary"),
  },
  async ({ yearId }) => {
    // response لازم يكون text فقط
    const result = {
      yearId,
      subjects: ["Math", "Arabic", "English"],
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result),
        },
      ],
    };
  }
);

/**
 * 3️⃣ HTTP Transport (مهم جداً)
 */
const transport = new StreamableHTTPServerTransport({
  endpoint: "/mcp",
});

/**
 * 4️⃣ MCP endpoint
 */
app.all("/mcp", async (req, res) => {
  try {
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP error:", err);
    res.status(500).json({ error: String(err) });
  }
});

/**
 * 5️⃣ Health check
 */
app.get("/", (_req, res) => {
  res.send("OK - MCP server running");
});

/**
 * 6️⃣ Start server
 */
const PORT = Number(process.env.PORT || 8080);

app.listen(PORT, "0.0.0.0", async () => {
  await server.connect(transport);
  console.log(`✅ MCP HTTP Server running on port ${PORT}`);
});

