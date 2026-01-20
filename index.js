import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

const server = new McpServer({
  name: "study-planner-mcp",
  version: "1.0.0",
});

const CURRICULUM_FN =
  process.env.CURRICULUM_FN_URL ||
  "https://us-central1-ai-students-85242.cloudfunctions.net/getCurriculum";

/* ---------- TOOLS ---------- */

server.tool(
  "load_curriculum",
  { yearId: z.string() },
  async ({ yearId }) => {
    const url = new URL(CURRICULUM_FN);
    url.searchParams.set("yearId", yearId);

    const r = await fetch(url);
    if (!r.ok) {
      return {
        isError: true,
        content: [{ type: "text", text: "❌ فشل تحميل المنهج" }],
      };
    }

    const curriculum = await r.json();

    return {
      content: [{ type: "text", text: "📘 تم تحميل المنهج" }],
      structuredContent: curriculum,
    };
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
    const allLessons = curriculum.subjects.flatMap((s) =>
      s.lessons.map((l) => ({
        subject: s.name,
        lessonId: l.lessonId,
        title: l.title,
      }))
    );

    const schedule = [];
    let i = 0;
    let day = 1;

    while (i < allLessons.length) {
      schedule.push({
        day,
        lessons: allLessons.slice(i, i + lessonsPerDay),
      });
      i += lessonsPerDay;
      day++;
    }

    return {
      content: [{ type: "text", text: "📅 جدول مبني على المنهج" }],
      structuredContent: {
        yearId: curriculum.yearId,
        schedule,
      },
    };
  }
);

/* ---------- TRANSPORT ---------- */

const transport = new StreamableHTTPServerTransport({});

/* ---------- ROUTES ---------- */

app.get("/", (_req, res) => {
  res.status(200).send("MCP Server is running ✅");
});

app.all("/mcp", async (req, res) => {
  try {
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});

/* ---------- LISTEN ---------- */

const port = Number(process.env.PORT || 8080);
app.listen(port, "0.0.0.0", () => {
  console.log("Listening on", port);
});
