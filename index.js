import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

const server = new McpServer({ name: "study-planner-mcp", version: "1.0.0" });

const CURRICULUM_FN =
  process.env.CURRICULUM_FN_URL ||
  "https://us-central1-ai-students-85242.cloudfunctions.net/getCurriculum";

server.tool(
  "load_curriculum",
  { yearId: z.string() },
  async ({ yearId }) => {
    const url = new URL(CURRICULUM_FN);
    url.searchParams.set("yearId", yearId);

    const r = await fetch(url.toString());
    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      return {
        isError: true,
        content: [{ type: "text", text: `❌ getCurriculum failed: ${r.status}` }],
        structuredContent: { ok: false, status: r.status, data },
      };
    }

    return {
      content: [{ type: "text", text: "📘 تم تحميل المنهج بنجاح" }],
      structuredContent: data,
    };
  }
);

server.tool(
  "generate_schedule_from_curriculum",
  {
    curriculum: z.any(),
    lessonsPerDay: z.number().int().min(1).max(5),
  },
  async ({ curriculum, lessonsPerDay }) => {
    const subjects = curriculum?.subjects || [];
    const allLessons = subjects.flatMap((s) =>
      (s.lessons || []).map((l) => ({
        subject: s.name,
        lessonId: l.lessonId,
        title: l.title,
      }))
    );

    const schedule = [];
    let i = 0;
    let day = 1;

    while (i < allLessons.length) {
      schedule.push({ day, lessons: allLessons.slice(i, i + lessonsPerDay) });
      i += lessonsPerDay;
      day++;
    }

    return {
      content: [{ type: "text", text: "📅 جدول مبني على المنهج" }],
      structuredContent: { yearId: curriculum?.yearId ?? null, schedule },
    };
  }
);

const transport = new StreamableHTTPServerTransport({});

app.get("/", (_req, res) => res.status(200).send("OK"));
app.all("/mcp", async (req, res) => {
  try {
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false });
  }
});

const port = Number(process.env.PORT || 8080);
app.listen(port, "0.0.0.0", () => console.log("Listening on", port));

server.connect(transport).then(() => console.log("MCP connected ✅"));
