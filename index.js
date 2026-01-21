import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Storage } from "@google-cloud/storage";

/* ---------------- App ---------------- */
const app = express();
app.use(express.json({ limit: "1mb" }));

/* ---------------- Config ---------------- */
// حطيه ثابت أو خليه ENV
const BUCKET_NAME =
  process.env.BUCKET_NAME || "ai-students-85242.appspot.com";

const storage = new Storage(); // Cloud Run بياخد ADC تلقائيًا

/* ---------------- MCP ---------------- */
const server = new McpServer({
  name: "study-planner-mcp",
  version: "1.0.0",
});

/* ---------------- Tools ---------------- */

/** load_curriculum: يقرأ JSON من Storage */
server.tool(
  "load_curriculum",
  { yearId: z.string() },
  async ({ yearId }) => {
    try {
      const bucket = storage.bucket(BUCKET_NAME);
      const file = bucket.file(`curriculums/${yearId}.json`);

      const [exists] = await file.exists();
      if (!exists) {
        return {
          isError: true,
          content: [{ type: "text", text: "❌ المنهج غير موجود في Storage" }],
        };
      }

      const [buf] = await file.download();
      const curriculum = JSON.parse(buf.toString("utf-8"));

      return {
        content: [{ type: "text", text: "📘 تم تحميل المنهج بنجاح" }],
        structuredContent: curriculum,
      };
    } catch (err) {
      console.error("load_curriculum error:", err);
      return {
        isError: true,
        content: [{ type: "text", text: "❌ حصل خطأ أثناء تحميل المنهج" }],
      };
    }
  }
);

/** generate_schedule_from_curriculum */
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
      structuredContent: { yearId: curriculum.yearId, schedule },
    };
  }
);

/* ---------------- Transport ---------------- */
const transport = new StreamableHTTPServerTransport({});

/* ---------------- Routes ---------------- */
app.get("/", (_req, res) => res.status(200).send("MCP Server is running ✅"));

app.all("/mcp", async (req, res) => {
  try {
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP handleRequest error:", err);
    res.status(500).json({ ok: false });
  }
});

/* ---------------- Start ---------------- */
const port = Number(process.env.PORT || 8080);
app.listen(port, "0.0.0.0", () => {
  console.log("Listening on", port);
});

// Connect بعد ما السيرفر يبدأ
server
  .connect(transport)
  .then(() => console.log("MCP connected ✅"))
  .catch((err) => console.error("MCP connect failed:", err));
