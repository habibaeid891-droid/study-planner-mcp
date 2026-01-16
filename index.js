import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/**
 * Basic Express app (required for Cloud Run)
 */
const app = express();
app.use(express.json());

/**
 * MCP Server
 */
const server = new McpServer({
  name: "study-planner-mcp",
  version: "1.0.0",
});

/**
 * ✅ Tool: get_curriculum
 */
server.tool(
  "get_curriculum",
  {
    yearId: z.string().describe("Academic year id, e.g. year_1_secondary"),
  },
  async ({ yearId }) => {
    if (yearId !== "year_1_secondary") {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Year not supported yet",
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "json",
          data: {
            yearId: "year_1_secondary",
            yearName: "الصف الأول الثانوي",
            subjects: [
              {
                subjectId: "arabic",
                name: "اللغة العربية",
                order: 1,
                lessons: [
                  {
                    lessonId: "ar_l1",
                    title: "النحو: الجملة الاسمية والفعلية",
                    estimatedMinutes: 45,
                    difficulty: 3,
                    order: 1,
                  },
                  {
                    lessonId: "ar_l2",
                    title: "البلاغة: التشبيه",
                    estimatedMinutes: 40,
                    difficulty: 3,
                    order: 2,
                  },
                  {
                    lessonId: "ar_l3",
                    title: "القراءة: نصوص أدبية",
                    estimatedMinutes: 35,
                    difficulty: 2,
                    order: 3,
                  },
                ],
              },
              {
                subjectId: "english",
                name: "اللغة الإنجليزية",
                order: 2,
                lessons: [
                  {
                    lessonId: "en_l1",
                    title: "Grammar: Tenses Review",
                    estimatedMinutes: 40,
                    difficulty: 2,
                    order: 1,
                  },
                  {
                    lessonId: "en_l2",
                    title: "Reading Comprehension",
                    estimatedMinutes: 35,
                    difficulty: 2,
                    order: 2,
                  },
                  {
                    lessonId: "en_l3",
                    title: "Writing: Paragraph Writing",
                    estimatedMinutes: 45,
                    difficulty: 3,
                    order: 3,
                  },
                ],
              },
              {
                subjectId: "math",
                name: "الرياضيات",
                order: 3,
                lessons: [
                  {
                    lessonId: "math_l1",
                    title: "الجبر: المعادلات الخطية",
                    estimatedMinutes: 50,
                    difficulty: 4,
                    order: 1,
                  },
                  {
                    lessonId: "math_l2",
                    title: "الهندسة: الزوايا والمثلثات",
                    estimatedMinutes: 45,
                    difficulty: 3,
                    order: 2,
                  },
                  {
                    lessonId: "math_l3",
                    title: "الإحصاء: التمثيل البياني",
                    estimatedMinutes: 40,
                    difficulty: 3,
                    order: 3,
                  },
                ],
              },
            ],
          },
        },
      ],
    };
  }
);

/**
 * MCP HTTP Transport
 */
const transport = new StreamableHTTPServerTransport({
  endpoint: "/mcp",
});


/**
 * Routes
 */
app.get("/", (_req, res) => {
  res.send("Study Planner MCP is running");
});

app.all("/mcp", async (req, res) => {
  await transport.handleRequest(req, res, req.body);
});

/**
 * Start server (Cloud Run)
 */
const port = Number(process.env.PORT || 8080);

app.listen(port, "0.0.0.0", async () => {
  console.log(`🚀 MCP server running on port ${port}`);
  await server.connect(transport);
});

