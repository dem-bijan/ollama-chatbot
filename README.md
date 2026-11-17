# Ollama Chatbot

Lab 1 (INPT, ASEDS INE3): a web chat GUI on top of a local LLM served by [Ollama](https://ollama.com).

```
Browser (public/) --POST /api/chat--> Express proxy (:3000) --POST /api/chat--> Ollama (:11434)
```

## Features

- Streaming answers (NDJSON) with a Stop button that really cancels the generation
- Conversation memory, a "New chat" button and a model selector
- Reasoning panel for models with the `thinking` capability
- Tokens/s statistics
- System prompt and temperature
- Markdown rendering, sanitized with DOMPurify
- Hardening: rate limiting, optional token auth and input size limits

## Run

Requires Node.js 22+ and Ollama with at least one chat model (tested with `qwen3.5:0.8b`).

```bash
ollama pull qwen3.5:0.8b
npm install
node server.js        # optional env: OLLAMA_MODEL, OLLAMA_URL, API_TOKEN, PORT
```

Open http://localhost:3000.

## Report

The lab report is in [`report/report.pdf`](report/report.pdf). Its LaTeX source is `report/report.tex`.
