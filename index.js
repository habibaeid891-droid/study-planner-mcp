import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import admin from "firebase-admin";

/* ---------- Firebase ---------- */
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  storageBucket: "ai-students-85242.appspot.com",
});

/* ---------- App ---------- */
const app = express();
app.use(express.json({ limit: "1mb" }));

/* ---------- MCP ---------- */
const server = new McpServer({
  name: "study-planner-mcp",
  version: "1.0.0",
});

/* ---------- TOOLS ---------- */

server.tool(
  "load_curriculum",
  { yearId: z.string() },
  async ({ yearId }) => {
    const bucket = admin.storage().bucket();
    const file = bucket.file(`curriculums/${yearId}.json`);

    const [exists] = await file.exists();
    if (!exists) {
      return {
        isError: true,
        content: [{ type: "text", text: "❌ المنهج غير موجود" }],
      };
    }

    const [buffer] = await file.download();
    const curriculum = JSON.parse(buffer.toString("utf-8"));

    return {
      content: [{ type: "text", text: "📘 تم تحميل المنهج بنجاح" }],
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

/* ---------- Transport ---------- */
const transport = new StreamableHTTPServerTransport({});

/* ---------- Routes ---------- */
app.get("/", (_req, res) => {
  res.send("MCP Server is running ✅");
});

app.all("/mcp", async (req, res) => {
  await transport.handleRequest(req, res, req.body);
});

/* ---------- START SERVER ---------- */
const port = Number(process.env.PORT || 8080);

app.listen(port, "0.0.0.0", () => {
  console.log("Listening on", port);
});

/* 🔥  بدون await */
server.connect(transport).then(() => {
  console.log("MCP connected ✅");
}).catch(err => {
  console.error("MCP connect failed", err);
});
