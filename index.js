import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Storage } from "@google-cloud/storage";

/* ---------- App ---------- */
const app = express();
app.use(express.json({ limit: "1mb" }));

/* ---------- Storage ---------- */
const storage = new Storage();
const BUCKET_NAME = "ai-students-85242.appspot.com";

/* ---------- MCP ---------- */
const server = new McpServer({
  name: "study-planner-mcp",
  version: "1.0.0",
});

/* ---------- Tools ---------- */

server.tool(
  "load_curriculum",
  { yearId: z.string() },
  async ({ yearId }) => {
    try {
      const file = storage
        .bucket(BUCKET_NAME)
        .file(`curriculums/${yearId}.json`);

      const [exists] = await file.exists();
      if (!exists) {
        return {
          isError: true,
          content: [{ type: "text", text: "❌ المنهج غير موجود" }],
        };
      }

      const [buf] = await file.download();
      const curriculum = JSON.parse(buf.toString("utf-8"));

      return {
        content: [{ type: "text", text: "📘 تم تحميل المنهج" }],
        structuredContent: curriculum,
      };
    } catch (e) {
      console.error(e);
      return {
        isError: true,
        content: [{ type: "text", text: "❌ خطأ أثناء تحميل المنهج" }],
      };
    }
  }
);

server.tool(
  "generate_schedule_from_curriculum",
  {
    curriculum: z.object({
      yearId: z.string(),
      subjects: z.array(
        z.object({
          name: z.string(),
          lessons: z.array(
            z.object({
              lessonId: z.string(),
              title: z.string(),
            })
          ),
        })
      ),
    }),
    lessonsPerDay: z.number().int().min(1).max(5),
  },
  async ({ curriculum, lessonsPerDay }) => {
    const lessons = curriculum.subjects.flatMap((s) =>
      s.lessons.map((l) => ({
        subject: s.name,
        lessonId: l.lessonId,
        title: l.title,
      }))
    );

    const schedule = [];
    let i = 0;
    let day = 1;

    while (i < lessons.length) {
      schedule.push({
        day,
        lessons: lessons.slice(i, i + lessonsPerDay),
      });
      i += lessonsPerDay;
      day++;
    }

    return {
      content: [{ type: "text", text: "📅 تم إنشاء الجدول" }],
      structuredContent: { yearId: curriculum.yearId, schedule },
    };
  }
);

/* ---------- Transport ---------- */
const transport = new StreamableHTTPServerTransport({});

/* ---------- Routes ---------- */

app.get("/", (_req, res) => {
  res.send("MCP Server is running ✅");
});

app.all("/mcp", async (req, res) => {
  await transport.handleRequest(req, res, req.body);
});

/* ---------- Start ---------- */
const port = Number(process.env.PORT || 8080);
app.listen(port, "0.0.0.0", () => {
  console.log("Listening on", port);
});
