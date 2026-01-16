import express from "express";
import admin from "firebase-admin";

/**
 * 🔹 Firebase Admin init (Storage only)
 * Cloud Run بيستخدم Service Account تلقائيًا
 */
admin.initializeApp({
  storageBucket: "ai-students-85242.firebasestorage.app",
});

const bucket = admin.storage().bucket();

const app = express();
app.use(express.json());

/**
 * 🔹 Get curriculum by year
 */
app.post("/get-curriculum", async (req, res) => {
  try {
    const { yearId } = req.body || {};

    if (!yearId) {
      return res.status(400).json({
        ok: false,
        error: "yearId is required",
      });
    }

    // دلوقتي بنجرب سنة واحدة بس
    if (yearId !== "year_1_secondary") {
      return res.status(404).json({
        ok: false,
        error: "Year not found",
      });
    }

    const file = bucket.file("curriculum_year_1_secondary.json");
    const [content] = await file.download();
    const data = JSON.parse(content.toString());

    return res.json({
      ok: true,
      data,
    });
  } catch (err) {
    console.error("get-curriculum error:", err);
    return res.status(500).json({
      ok: false,
      error: "Internal server error",
    });
  }
});

/**
 * 🔹 Health check
 */
app.get("/", (_req, res) => {
  res.send("Curriculum API is running");
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Curriculum API listening on ${port}`);
});
server.tool(
  "get_curriculum",
  {
    yearId: z.string(),
  },
  async ({ yearId }) => {
    const r = await fetch(
      "https://curriculum-mcp-1013957397733.europe-west1.run.app/get-curriculum",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ yearId }),
      }
    );

    const data = await r.json().catch(() => ({}));

    if (!r.ok || !data?.ok) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Failed to load curriculum: ${JSON.stringify(data)}`,
          },
        ],
        structuredContent: {
          ok: false,
          error: data?.error ?? "unknown error",
        },
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `Curriculum loaded for ${yearId}`,
        },
      ],
      structuredContent: {
        ok: true,
        curriculum: data.data,
      },
    };
  }
);
