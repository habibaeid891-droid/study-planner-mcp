import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Redis } from "@upstash/redis";

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

server.tool(
  "get_curriculum",
  {
yearid: z.string()
  },
  async ({ yearid }) => {
    return {
      content: [
        {
          type: "json",
          data: {
            yearid,
            subjects: ["Math", "Arabic", "English"],
          },
        },
      ],
    };
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
  const t0 = Date.now();
  const info = classifyMcpBody(req.body);

  if (MCP_DEBUG) {
    console.log(
      "[MCP_IN]",
      safeJson({
        type: info.type,
        method: info.method,
        toolName: info.toolName,
        conversationId: info.conversationId,
        contentType: req.headers["content-type"],
        bodyPreview: safeJson(req.body).slice(0, 500),
      })
    );
  }

  try {
    await transport.handleRequest(req, res, req.body);
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

