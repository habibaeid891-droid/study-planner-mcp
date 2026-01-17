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
        type: "text",
        text: "yearId is required",
      });
    }

    // دلوقتي بنجرب سنة واحدة بس
    if (yearId !== "year_1_secondary") {
      return res.status(404).json({
        type: "text",
        text: "Year not found",
      });
    }

    const file = bucket.file("curriculum_year_1_secondary.json");
    const [content] = await file.download();
    const data = JSON.parse(content.toString());

    // Format response according to MCP spec
    return res.json({
      content: [
        {
          type: "text",
          text: JSON.stringify(data, null, 2), // تحويل البيانات لنص منظم
        }
      ],
    });
  } catch (err) {
    console.error("get-curriculum error:", err);
    return res.status(500).json({
      content: [
        {
          type: "text",
          text: `Internal server error: ${err.message}`,
        }
      ],
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
