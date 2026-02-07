import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Redis } from "@upstash/redis";
import admin from "firebase-admin";

try {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
    });
    console.log("Firebase admin initialized ✅");
  }
} catch (e) {
  console.error("Firebase init failed ❌", e);
}

const db = admin.firestore();

/**
 * Existing Firebase Chat Functions
 */
const POST_URL =
  "https://us-central1-ai-students-85242.cloudfunctions.net/saveApiMessageToFirebase/chat/log";

const GET_BASE =
  "https://us-central1-ai-students-85242.cloudfunctions.net/saveApiMessageToFirebase/chat/turns";

/**
 * ✅ Student Functions
 */
const UPSERT_STUDENT_URL =
  "https://us-central1-ai-students-85242.cloudfunctions.net/upsertStudent";

const GET_STUDENT_BASE =
  "https://us-central1-ai-students-85242.cloudfunctions.net/getStudent";

/**
 * ✅ EduAgent URL
 */
const EDU_AGENT_URL =
  "https://us-central1-ai-students-85242.cloudfunctions.net/jsonFormatAgent/chat";

const app = express();
app.use(express.json({ limit: "1mb" }));

/**
 * ✅ Redis (Upstash) init
 * لازم تضيف env vars في Cloud Run:
 * - UPSTASH_REDIS_REST_URL
 * - UPSTASH_REDIS_REST_TOKEN
 */
const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      })
    : null;

const CACHE_ENABLED = !!redis;

// ✅ Cache policy
const WINDOW_SIZE = Number(process.env.SESSION_WINDOW_SIZE || 20);
const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS || 86400);

// ✅ DEBUG toggles
const MCP_DEBUG = process.env.MCP_DEBUG === "1";
const DEDUPE_WINDOW_MS = Number(process.env.DEDUPE_WINDOW_MS || 5000); // ✅ default 5s

/**
 * ✅ Redis key per conversation
 */
function redisKeys(conversationId) {
  return {
    msgs: `sess:${conversationId}:msgs`, // Redis LIST
  };
}

async function setTTL(conversationId) {
  if (!CACHE_ENABLED) return;
  const { msgs } = redisKeys(conversationId);
  await redis.expire(msgs, SESSION_TTL_SECONDS);
}

/**
 * ✅ Redis: get recent turns from cache
 * FIXED: Upstash may return objects; handle both string/object.
 */
async function getTurnsFromCache(conversationId, maxTurns) {
  if (!CACHE_ENABLED) return null;

  const { msgs } = redisKeys(conversationId);
  const raw = await redis.lrange(msgs, 0, Math.max(0, maxTurns - 1));
  if (!raw || raw.length === 0) return null;

  const messages = raw
    .map((x) => (typeof x === "string" ? JSON.parse(x) : x)) // ✅ FIX
    .reverse()
    .map((m) => ({
      id: m.id ?? null,
      role: m.role ?? null,
      content: m.content ?? "",
      createdAtSeconds: m.createdAtSeconds ?? null,
      createdAtNanos: m.createdAtNanos ?? null,
    }));

  return messages;
}

/**
 * ✅ Redis: overwrite cache window from Firebase response
 */
async function writeTurnsToCache(conversationId, messages = []) {
  if (!CACHE_ENABLED) return;

  const { msgs } = redisKeys(conversationId);
  await redis.del(msgs);

  const normalized = (messages || []).map((m) => ({
    id: m.id ?? null,
    role: m.role ?? null,
    content: m.content ?? "",
    createdAtSeconds: m?.createdAt?._seconds ?? m.createdAtSeconds ?? null,
    createdAtNanos: m?.createdAt?._nanoseconds ?? m.createdAtNanos ?? null,
  }));

  // store newest-first, so LPUSH in reverse
  for (let i = normalized.length - 1; i >= 0; i--) {
    await redis.lpush(msgs, JSON.stringify(normalized[i])); // ✅ ALWAYS STRING
  }

  await redis.ltrim(msgs, 0, WINDOW_SIZE - 1);
  await setTTL(conversationId);
}

/**
 * ✅ Redis: append new message after successful Firebase save
 */
async function appendMessageToCache(conversationId, messageObj) {
  if (!CACHE_ENABLED) return;

  const { msgs } = redisKeys(conversationId);
  await redis.lpush(msgs, JSON.stringify(messageObj));
  await redis.ltrim(msgs, 0, WINDOW_SIZE - 1);
  await setTTL(conversationId);
}

/**
 * ✅ Utility: safe stringify for logs
 */
function safeJson(x) {
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

/**
 * ✅ MCP request classifier
 */
function classifyMcpBody(body) {
  if (!body) return { type: "unknown" };

  const method = body.method || body?.request?.method;
  const params = body.params || body?.request?.params;

  let toolName = null;
  let conversationId = null;

  if (params?.name) toolName = params.name;
  if (params?.arguments?.conversationId) conversationId = params.arguments.conversationId;

  const m = (method || "").toLowerCase();
  if (m.includes("initialize")) return { type: "initialize", method };
  if (m.includes("tools/list")) return { type: "tools_list", method };
  if (m.includes("tools/call"))
    return { type: "tool_call", method, toolName, conversationId };

  if (toolName) return { type: "tool_call", method: method || "unknown", toolName, conversationId };
  return { type: method ? "rpc" : "unknown", method, toolName, conversationId };
}

/**
 * ✅ Dedupe tracker (prevents repeated identical get_turns calls in short window)
 */
const recentCalls = new Map();
function isDuplicateCall(key) {
  const now = Date.now();
  const prev = recentCalls.get(key);
  if (prev && now - prev < DEDUPE_WINDOW_MS) return true;
  recentCalls.set(key, now);
  return false;
}

/**
 * 1) MCP server
 */
const server = new McpServer({ name: "agent-bridge", version: "1.0.0" });

/**
 * ✅ Helpers for patches -> data
 */
function setDeep(obj, path, value) {
  const keys = path.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (!cur[k] || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

function isEmptyValue(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === "string" && v.trim() === "") return true;
  if (Array.isArray(v) && v.length === 0) return true;
  if (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0)
    return true;
  return false;
}

function patchValue(p) {
  if (p.valueType === "string") return p.valueString;
  if (p.valueType === "number") return p.valueNumber;
  if (p.valueType === "boolean") return p.valueBoolean;
  return undefined;
}

function patchesToData(patches = [], allowClear = false) {
  const data = {};
  for (const p of patches) {
    const v = patchValue(p);
    if (!allowClear && isEmptyValue(v)) continue;
    setDeep(data, p.path, v);
  }
  return data;
}

/**
 * 2) Tools
 */
//get_curriculum_by_year
server.tool(
  "get_curriculum_by_year",
  {
    // ✅ schema بسيط
    yearId: z.string(),
  },
  async ({ yearId }) => {
    const finalYearId = yearId && yearId.trim() !== ""
      ? yearId
      : "year_1_secondary";

    try {
      const collectionName = `curriculum_${finalYearId}`;
      const snapshot = await db.collection(collectionName).get();

      const subjects = [];

      snapshot.forEach((doc) => {
        const data = doc.data();

        let lessons = [];
        for (const key of Object.keys(data)) {
          if (Array.isArray(data[key])) {
            lessons = data[key];
            break;
          }
        }

        subjects.push({
          subjectId: data.subjectId || doc.id,
          lessons,
        });
      });

      if (subjects.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `❌ لا يوجد منهج للسنة ${finalYearId}`,
            },
          ],
          structuredContent: {
            ok: false,
            yearId: finalYearId,
            subjects: [],
          },
        };
      }

      const text = `📘 منهج السنة الدراسية: ${finalYearId}

${subjects
  .map(
    (s) =>
      `- ${s.subjectId}\n${s.lessons.map((l) => `  • ${l}`).join("\n")}`
  )
  .join("\n\n")}`;

      return {
        content: [{ type: "text", text }],
        structuredContent: {
          ok: true,
          yearId: finalYearId,
          subjects,
          subjectCount: subjects.length,
        },
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `❌ خطأ أثناء قراءة المنهج: ${err?.message || String(err)}`,
          },
        ],
        structuredContent: {
          ok: false,
          error: err?.message || String(err),
        },
      };
    }
  }
);

// ✅ Tool #1: log_message (Firebase save + Redis append)
server.tool(
  "log_message",
  {
    conversationId: z.string(),
    userId: z.string(),
    role: z.enum(["user", "assistant", "system"]).default("user"),
    content: z.string(),
  },
  async ({ conversationId, userId, role, content }) => {
    const r = await fetch(POST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId, userId, role, content }),
    });

    const data = await r.json().catch(() => ({}));

    if (!r.ok || !data?.ok) {
      return {
        isError: true,
        content: [{ type: "text", text: `POST failed: ${JSON.stringify(data)}` }],
        structuredContent: { ok: false, status: r.status, error: data?.error ?? data },
      };
    }

    // ✅ cache append (don't fail if cache fails)
    if (CACHE_ENABLED) {
      try {
        await appendMessageToCache(conversationId, {
          id: data.messageId ?? null,
          role,
          content,
          createdAtSeconds: Math.floor(Date.now() / 1000),
          createdAtNanos: 0,
        });
        console.log("[CACHE_APPEND]", conversationId, "role=", role, "id=", data.messageId ?? "na");
      } catch (e) {
        console.warn("Redis append failed:", e?.message || e);
      }
    }

    return {
      content: [{ type: "text", text: `Saved ✅ messageId=${data.messageId}` }],
      structuredContent: {
        ok: true,
        messageId: data.messageId,
        conversationId,
        userId,
        role,
        cacheEnabled: CACHE_ENABLED,
      },
    };
  }
);

// ✅ Tool #2: get_turns (Redis cache first; fallback Firebase; then cache write)
server.tool(
  "get_turns",
  {
    conversationId: z.string(),
    maxTurns: z.number().int().positive().default(5),
    lookback: z.number().int().positive().default(120),
  },
  async ({ conversationId, maxTurns, lookback }) => {
    const dedupeKey = `get_turns:${conversationId}:${maxTurns}:${lookback}`;

    // ✅ DEDUPE repeated identical calls in short window
    if (isDuplicateCall(dedupeKey)) {
      if (CACHE_ENABLED) {
        const cached = await getTurnsFromCache(conversationId, maxTurns);
        if (cached && cached.length > 0) {
          console.log("[DEDUPED]", conversationId, "served from cache");
          console.log("[CACHE_HIT]", conversationId, "count=", cached.length);

          const text =
            cached.map((m) => `[${m.role}] ${m.content} (id=${m.id ?? "na"})`).join("\n") ||
            "No messages";

          return {
            content: [{ type: "text", text }],
            structuredContent: {
              ok: true,
              cache: "HIT(DEDUPED)",
              conversationId,
              maxTurns,
              lookback,
              messageCount: cached.length,
              messages: cached,
            },
          };
        }
      }
      // لو مفيش كاش، هنكمل عادي
    }

    // 1) Try Redis cache first
    if (CACHE_ENABLED) {
      try {
        const cached = await getTurnsFromCache(conversationId, maxTurns);
        if (cached && cached.length > 0) {
          console.log("[CACHE_HIT]", conversationId, "count=", cached.length);

          const text =
            cached.map((m) => `[${m.role}] ${m.content} (id=${m.id ?? "na"})`).join("\n") ||
            "No messages";

          return {
            content: [{ type: "text", text }],
            structuredContent: {
              ok: true,
              cache: "HIT",
              conversationId,
              maxTurns,
              lookback,
              messageCount: cached.length,
              messages: cached,
            },
          };
        }
      } catch (e) {
        console.warn("Redis read failed:", e?.message || e);
      }
    }

    // 2) Cache miss -> Firebase function
    console.log("[CACHE_MISS]", conversationId, "calling Firebase turns...");

    const url = new URL(GET_BASE);
    url.searchParams.set("conversationId", conversationId);
    url.searchParams.set("maxTurns", String(maxTurns));
    url.searchParams.set("lookback", String(lookback));

    const r = await fetch(url.toString());
    const data = await r.json().catch(() => ({}));

    if (!r.ok || !data?.ok) {
      return {
        isError: true,
        content: [{ type: "text", text: `GET failed: ${JSON.stringify(data)}` }],
        structuredContent: {
          ok: false,
          status: r.status,
          error: data?.error ?? data,
          conversationId,
          maxTurns,
          lookback,
        },
      };
    }

    const structuredMessages = (data.messages || []).map((m) => ({
      id: m.id ?? null,
      role: m.role ?? null,
      content: m.content ?? "",
      createdAtSeconds: m?.createdAt?._seconds ?? null,
      createdAtNanos: m?.createdAt?._nanoseconds ?? null,
    }));

    // 3) Write to cache
    if (CACHE_ENABLED) {
      try {
        await writeTurnsToCache(conversationId, data.messages || []);
        console.log("[CACHE_WROTE]", conversationId, "count=", (data.messages || []).length);
      } catch (e) {
        console.warn("Redis write failed:", e?.message || e);
      }
    }

    const text =
      structuredMessages.map((m) => `[${m.role}] ${m.content} (id=${m.id ?? "na"})`).join("\n") ||
      "No messages";

    return {
      content: [{ type: "text", text }],
      structuredContent: {
        ok: true,
        cache: CACHE_ENABLED ? "MISS->WROTE" : "DISABLED",
        conversationId: data.conversationId ?? conversationId,
        maxTurns: data.maxTurns ?? maxTurns,
        lookback: data.lookback ?? lookback,
        messageCount: structuredMessages.length,
        messages: structuredMessages,
      },
    };
  }
);

// ✅ Tool #3: upsert_student
server.tool(
  "upsert_student",
  {
    uid: z.string().optional(),
    email: z.union([z.string().email(), z.literal("")]).optional(),
    patches: z
      .array(
        z.object({
          path: z.string().min(1),
          valueType: z.enum(["string", "number", "boolean"]),
          valueString: z.string(),
          valueNumber: z.number(),
          valueBoolean: z.boolean(),
        })
      )
      .default([]),
    allowClear: z.boolean().optional().default(false),
  },
  async (input) => {
    const uid = input.uid && input.uid.trim() !== "" ? input.uid.trim() : undefined;
    const emailRaw = input.email && input.email.trim() !== "" ? input.email.trim() : undefined;
    const email = emailRaw && emailRaw.length > 0 ? emailRaw : undefined;

    const finalUid = uid || (!email ? "uid_123" : undefined);

    if (!finalUid && !email) {
      return {
        isError: true,
        content: [{ type: "text", text: "You must provide uid or email." }],
        structuredContent: { ok: false, error: "invalid-argument", message: "Provide uid or email" },
      };
    }

    const data = patchesToData(input.patches || [], input.allowClear === true);

    if (!data || Object.keys(data).length === 0) {
      return {
        content: [{ type: "text", text: "No changes to save (empty/invalid patches). ✅" }],
        structuredContent: {
          ok: true,
          uid: finalUid ?? null,
          email: email ?? null,
          skippedWrite: true,
          patchCount: (input.patches || []).length,
        },
      };
    }

    const r = await fetch(UPSERT_STUDENT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid: finalUid, email, data }),
    });

    const resData = await r.json().catch(() => ({}));

    if (!r.ok || !resData?.ok) {
      return {
        isError: true,
        content: [{ type: "text", text: `Upsert failed: ${JSON.stringify(resData)}` }],
        structuredContent: {
          ok: false,
          status: r.status,
          error: resData?.error ?? resData,
          uid: finalUid ?? null,
          email: email ?? null,
        },
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `Student upserted ✅ uid=${resData.uid} (patches=${(input.patches || []).length})`,
        },
      ],
      structuredContent: {
        ok: true,
        uid: resData.uid,
        message: resData.message ?? "Student upsert success",
        patchCount: (input.patches || []).length,
      },
    };
  }
);

// ✅ Tool #4: get_student
server.tool(
  "get_student",
  {
    uid: z.string().optional(),
    email: z.union([z.string().email(), z.literal("")]).optional(),
  },
  async (input) => {
    const uid = input.uid && input.uid.trim() !== "" ? input.uid.trim() : undefined;
    const emailRaw = input.email && input.email.trim() !== "" ? input.email.trim() : undefined;
    const email = emailRaw && emailRaw.length > 0 ? emailRaw : undefined;

    const finalUid = uid || (!email ? "uid_123" : undefined);

    const url = new URL(GET_STUDENT_BASE);
    if (finalUid) url.searchParams.set("uid", finalUid);
    if (email) url.searchParams.set("email", email);

    const r = await fetch(url.toString());
    const resData = await r.json().catch(() => ({}));

    if (!r.ok || !resData?.ok) {
      return {
        isError: true,
        content: [{ type: "text", text: `Get failed: ${JSON.stringify(resData)}` }],
        structuredContent: {
          ok: false,
          status: r.status,
          error: resData?.error ?? resData,
          uid: finalUid ?? null,
          email: email ?? null,
        },
      };
    }

    const profileName = resData?.student?.profile?.fullName ?? "Unknown";
    const course = resData?.student?.abilityState?.course ?? "Unknown";
    const text = `Student ✅ uid=${resData.uid}\nName=${profileName}\nCourse=${course}`;

    return {
      content: [{ type: "text", text }],
      structuredContent: { ok: true, uid: resData.uid, student: resData.student },
    };
  }
);

// ✅ Tool #5: ask_edu_agent (JSON Format Agent)
server.tool(
  "ask_edu_agent",
  {
    message: z.string().min(1, "Message cannot be empty"),
  },
  async ({ message }) => {
    try {
      const r = await fetch(EDU_AGENT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });

      const data = await r.json().catch(() => ({}));

      if (!r.ok) {
        return {
          isError: true,
          content: [
            { 
              type: "text", 
              text: `EduAgent request failed: ${JSON.stringify(data)}` 
            }
          ],
          structuredContent: {
            ok: false,
            status: r.status,
            error: data?.error ?? data,
            message,
          },
        };
      }

      // ✅ Parse the response structure
      const reply = data?.reply;
      const outputParsed = reply?.output_parsed;
      
      if (!outputParsed) {
        return {
          isError: true,
          content: [
            { 
              type: "text", 
              text: "EduAgent response missing output_parsed structure" 
            }
          ],
          structuredContent: {
            ok: false,
            error: "invalid-response",
            rawData: data,
          },
        };
      }

      // ✅ Extract key info for text response
      const agentName = outputParsed.agent_name ?? "EduGuide";
      const userName = outputParsed.user?.name ?? "الطالب";
      const topic = outputParsed.topic?.detected_topic ?? "موضوع تعليمي";
      const summary = outputParsed.answer?.summary ?? "";
      const stepsCount = outputParsed.answer?.steps?.length ?? 0;
      const comingUpCount = outputParsed.coming_up?.length ?? 0;

      const text = `✅ ${agentName} Response:
━━━━━━━━━━━━━━━━━━━━
👤 Student: ${userName}
📚 Topic: ${topic}
📝 Difficulty: ${outputParsed.topic?.difficulty_level ?? "N/A"}

📖 Summary:
${summary}

🔢 Steps: ${stepsCount} steps provided
📅 Coming Up: ${comingUpCount} items planned

✨ Full structured data available in structuredContent`;

      return {
        content: [{ type: "text", text }],
        structuredContent: {
          ok: true,
          agentName,
          user: outputParsed.user,
          topic: outputParsed.topic,
          answer: outputParsed.answer,
          comingUp: outputParsed.coming_up,
          rawResponse: data,
        },
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          { 
            type: "text", 
            text: `EduAgent error: ${err?.message || String(err)}` 
          }
        ],
        structuredContent: {
          ok: false,
          error: "exception",
          message: err?.message || String(err),
        },
      };
    }
  }
);

/**
 * 3) Streamable HTTP transport
 */
const transport = new StreamableHTTPServerTransport({});

/**
 * 4) Express routes
 */
app.get("/", (_req, res) => res.status(200).send("OK - agent-bridge is running"));

app.all("/mcp", async (req, res) => {
  const body = req.body;
  const t0 = Date.now();
  const info = classifyMcpBody(body);

  // ✅ MCP JSON-RPC GUARD (الإضافة الوحيدة المهمة)
  if (
    !body ||
    body.jsonrpc !== "2.0" ||
    typeof body.method !== "string"
  ) {
    return res.status(400).json({
      ok: false,
      error: "Invalid MCP JSON-RPC request",
    });
  }

  if (MCP_DEBUG) {
    console.log(
      "[MCP_IN]",
      safeJson({
        type: info.type,
        method: info.method,
        toolName: info.toolName,
        conversationId: info.conversationId,
        contentType: req.headers["content-type"],
        bodyPreview: safeJson(body).slice(0, 500),
      })
    );
  }

  try {
    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error("handleRequest error:", err);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  } finally {
    if (MCP_DEBUG) {
      console.log(
        "[MCP_OUT]",
        safeJson({ ms: Date.now() - t0, type: info.type, toolName: info.toolName })
      );
    }
  }
});

/**
 * ✅ Optional debug endpoint to clear Redis key for a conversation
 * Use temporarily then remove
 */
app.post("/debug/redis/clear", async (req, res) => {
  try {
    const { conversationId } = req.body || {};
    if (!conversationId) {
      return res.status(400).json({ ok: false, error: "conversationId required" });
    }
    if (!CACHE_ENABLED) {
      return res.status(400).json({ ok: false, error: "Redis disabled" });
    }

    const { msgs } = redisKeys(conversationId);
    await redis.del(msgs);

    return res.json({ ok: true, deleted: msgs });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * 5) Start listening
 */
const port = Number(process.env.PORT || 8080);

app.listen(port, "0.0.0.0", () => {
  console.log(`Listening on ${port}`);
  console.log(`Redis cache: ${CACHE_ENABLED ? "ENABLED ✅" : "DISABLED (missing env vars)"}`);
  console.log(`MCP debug: ${MCP_DEBUG ? "ON ✅" : "OFF"}`);
  console.log(`Dedupe window ms: ${DEDUPE_WINDOW_MS}`);
  console.log(`Window size: ${WINDOW_SIZE}, TTL seconds: ${SESSION_TTL_SECONDS}`);
});

/**
 * 6) Connect MCP server after listen
 */
server
  .connect(transport)
  .then(() => console.log("MCP server connected ✅"))
  .catch((err) => console.error("MCP connect error:", err));

