// server.js - Express proxy between the browser and Ollama.
// The browser never talks to Ollama directly: this is where limits and auth live.
import express from "express";
import rateLimit from "express-rate-limit";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const PORT = Number(process.env.PORT ?? 3000);
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const DEFAULT_MODEL = process.env.OLLAMA_MODEL ?? "qwen3.5:0.8b";
// Optional shared secret. If set, every /api request must send "Authorization: Bearer <token>".
const API_TOKEN = process.env.API_TOKEN ?? "";
const MAX_MESSAGES = 100;          // hardening: cap the conversation length
const MAX_CHARS = 20_000;          // hardening: cap the total text size

const app = express();

// Body parser with a size limit (images in base64 can be big, but not unlimited).
app.use(express.json({ limit: "8mb" }));

// Same origin serves the page and the API -> no CORS needed.
app.use(express.static("public"));
// Serve the browser builds of marked + DOMPurify from node_modules (no CDN).
app.use("/vendor/marked", express.static("node_modules/marked/lib"));
app.use("/vendor/dompurify", express.static("node_modules/dompurify/dist"));

// ---- Hardening (Step 5) ----------------------------------------------------
app.use("/api", rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false,
  message: { error: "Too many requests, slow down (20 per minute)." } }));

app.use("/api", (req, res, next) => {
  if (!API_TOKEN) return next(); // auth disabled when no token configured
  const header = req.get("authorization") ?? "";
  if (header === `Bearer ${API_TOKEN}`) return next();
  res.status(401).json({ error: "Missing or invalid token." });
});

// Small helper: validate the messages array sent by the browser.
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

// ---- POST /api/chat -------------------------------------------------------
app.post("/api/chat", async (req, res) => {
  const { messages, model = DEFAULT_MODEL, stream = true, think, options, format } = req.body ?? {};

  const problem = validateMessages(messages);
  if (problem) return res.status(400).json({ error: problem });

  // Build the body for Ollama. Optional fields are forwarded only if present.
  const body = { model, messages, stream };
  if (think !== undefined) body.think = think;
  if (options !== undefined) body.options = options;
  if (format !== undefined) body.format = format;

  // Abort the Ollama request if the client goes away.
  // We listen on res, not req: req "close" fires as soon as the request body has
  // been read (i.e. immediately), while res "close" fires when the connection
  // closes before/after we finished answering.
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

    // Ollama answered but with an error (e.g. 404 model not found): forward it.
    if (!r.ok) {
      const text = await r.text();
      let error;
      try { error = JSON.parse(text).error; } catch { error = text; }
      return res.status(r.status).json({ error: error || `Ollama returned ${r.status}` });
    }

    if (!stream) {
      return res.json(await r.json()); // Step 2 behaviour
    }

    // Step 3: forward the NDJSON bytes as they arrive, no parsing.
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    res.flushHeaders();
    await pipeline(Readable.fromWeb(r.body), res);
  } catch (err) {
    // Client left (Stop button / closed tab): nothing to send, not an error.
    if (controller.signal.aborted) {
      console.log("client disconnected -> Ollama request aborted");
      return;
    }
    console.error("chat error:", err.message);
    if (res.headersSent) return res.end(); // too late for a JSON error
    res.status(502).json({ error: `Cannot reach Ollama at ${OLLAMA_URL}` });
  }
});

// ---- GET /api/models ------------------------------------------------------
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

// Lets the page know whether it should ask for a token.
app.get("/config", (_req, res) => res.json({ defaultModel: DEFAULT_MODEL, authRequired: Boolean(API_TOKEN) }));

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Chat GUI on http://localhost:${PORT}  (Ollama: ${OLLAMA_URL}, default model: ${DEFAULT_MODEL}${API_TOKEN ? ", auth ON" : ""})`);
});
