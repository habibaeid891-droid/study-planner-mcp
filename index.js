import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/**
 * Express app
 */
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
 * Tool: get_curriculum
 */
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
 * MCP Transport
 */
const transport = new StreamableHTTPServerTransport({
  endpoint: "/mcp",
});

/**
 * 🔴 دي السطر المهم
 * خلي الـ transport يركّب نفسه
 */
app.use(transport.middleware());

/**
 * Health check
 */
app.get("/", (_req, res) => {
  res.send("Study Planner MCP is running");
});

/**
 * Start server
 */
const port = Number(process.env.PORT || 8080);

app.listen(port, "0.0.0.0", async () => {
  console.log(`🚀 MCP server running on port ${port}`);
  await server.connect(transport);
});
