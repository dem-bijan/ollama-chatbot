// Express server that serves the chat page and proxies requests to Ollama.
import express from "express";
import rateLimit from "express-rate-limit";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// Configuration
const PORT = Number(process.env.PORT ?? 3000);
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const DEFAULT_MODEL = process.env.OLLAMA_MODEL ?? "qwen3.5:0.8b";
const API_TOKEN = process.env.API_TOKEN ?? "";
const MAX_MESSAGES = 100;
const MAX_CHARS = 20_000;

const app = express();

// Static files and body parsing
app.use(express.json({ limit: "8mb" }));
app.use(express.static("public"));
app.use("/vendor/marked", express.static("node_modules/marked/lib"));
app.use("/vendor/dompurify", express.static("node_modules/dompurify/dist"));

// Security: rate limiting and optional token authentication
app.use("/api", rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false,
  message: { error: "Too many requests, slow down (20 per minute)." } }));

app.use("/api", (req, res, next) => {
  if (!API_TOKEN) return next();
  const header = req.get("authorization") ?? "";
  if (header === `Bearer ${API_TOKEN}`) return next();
  res.status(401).json({ error: "Missing or invalid token." });
});

// Input validation
function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "messages must be a non-empty array";
  if (messages.length > MAX_MESSAGES) return `too many messages (max ${MAX_MESSAGES})`;
  let total = 0;
  for (const m of messages) {
    if (!m || typeof m.content !== "string" || !["system", "user", "assistant"].includes(m.role)) {
      return "each message needs a role (system|user|assistant) and a string content";
    }
    total += m.content.length;
  }
  if (total > MAX_CHARS) return `conversation too long (max ${MAX_CHARS} characters)`;
  return null;
}

// Chat route: forwards the conversation to Ollama, streamed or not, and cancels on disconnect
app.post("/api/chat", async (req, res) => {
  const { messages, model = DEFAULT_MODEL, stream = true, think, options, format } = req.body ?? {};

  const problem = validateMessages(messages);
  if (problem) return res.status(400).json({ error: problem });

  const body = { model, messages, stream };
  if (think !== undefined) body.think = think;
  if (options !== undefined) body.options = options;
  if (format !== undefined) body.format = format;

  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });

  try {
    const r = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!r.ok) {
      const text = await r.text();
      let error;
      try { error = JSON.parse(text).error; } catch { error = text; }
      return res.status(r.status).json({ error: error || `Ollama returned ${r.status}` });
    }

    if (!stream) {
      return res.json(await r.json());
    }

    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    res.flushHeaders();
    await pipeline(Readable.fromWeb(r.body), res);
  } catch (err) {
    if (controller.signal.aborted) {
      console.log("client disconnected -> Ollama request aborted");
      return;
    }
    console.error("chat error:", err.message);
    if (res.headersSent) return res.end();
    if (err.cause?.code === "UND_ERR_HEADERS_TIMEOUT") {
      return res.status(504).json({ error: "Ollama took more than 5 minutes to answer. Use streaming or a shorter question." });
    }
    res.status(502).json({ error: `Cannot reach Ollama at ${OLLAMA_URL}` });
  }
});

// Models route: lists local models with their capabilities
app.get("/api/models", async (_req, res) => {
  try {
    const tags = await fetch(`${OLLAMA_URL}/api/tags`).then((r) => r.json());
    const models = await Promise.all(
      (tags.models ?? []).map(async ({ name }) => {
        const info = await fetch(`${OLLAMA_URL}/api/show`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: name }),
        }).then((r) => r.json());
        return { name, capabilities: info.capabilities ?? [] };
      }),
    );
    res.json(models);
  } catch (err) {
    console.error("models error:", err.message);
    res.status(502).json({ error: `Cannot reach Ollama at ${OLLAMA_URL}` });
  }
});

// Client configuration
app.get("/config", (_req, res) => res.json({ defaultModel: DEFAULT_MODEL, authRequired: Boolean(API_TOKEN) }));

// Start
app.listen(PORT, "127.0.0.1", () => {
  console.log(`Chat GUI on http://localhost:${PORT}  (Ollama: ${OLLAMA_URL}, default model: ${DEFAULT_MODEL}${API_TOKEN ? ", auth ON" : ""})`);
});
