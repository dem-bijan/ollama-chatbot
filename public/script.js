// Chat page logic: conversation, streaming display and controls.

const $ = (id) => document.getElementById(id);
const els = {
  model: $("model"), thinkWrap: $("think-wrap"), think: $("think"), newChat: $("new-chat"),
  settingsToggle: $("settings-toggle"), settings: $("settings"), system: $("system"),
  temperature: $("temperature"), tempValue: $("temp-value"), markdown: $("markdown"),
  tokenWrap: $("token-wrap"), token: $("token"),
  messages: $("messages"), error: $("error"), form: $("composer"), input: $("input"),
  send: $("send"), stop: $("stop"),
};

// State
let history = [];
let models = [];
let controller = null;

// Helpers

function authHeaders() {
  const t = els.token.value.trim();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = !message;
}

function setBusy(busy) {
  els.input.disabled = busy;
  els.model.disabled = busy;
  els.think.disabled = busy;
  els.newChat.disabled = busy;
  els.send.hidden = busy;
  els.stop.hidden = !busy;
}

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

// Rendering
function renderContent(el, text) {
  if (els.markdown.checked) {
    el.classList.remove("plain");
    el.innerHTML = DOMPurify.sanitize(marked.parse(text));
  } else {
    el.classList.add("plain");
    el.textContent = text;
  }
}

function addUserBubble(text) {
  const div = document.createElement("div");
  div.className = "msg user";
  div.textContent = text;
  els.messages.append(div);
  scrollToBottom();
  return div;
}

function addAssistantBubble() {
  const div = document.createElement("div");
  div.className = "msg assistant";

  const thinking = document.createElement("details");
  thinking.className = "thinking";
  thinking.hidden = true;
  const summary = document.createElement("summary");
  summary.textContent = "Reasoning";
  const thinkingText = document.createElement("div");
  thinking.append(summary, thinkingText);

  const content = document.createElement("div");
  content.className = "content";
  const stats = document.createElement("div");
  stats.className = "stats";

  div.append(thinking, content, stats);
  els.messages.append(div);
  scrollToBottom();
  return { div, thinking, thinkingText, content, stats };
}

// NDJSON stream reader
async function* readNDJSON(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield JSON.parse(line);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield JSON.parse(buffer);
}

// Models

function currentModel() {
  return models.find((m) => m.name === els.model.value);
}

function updateThinkToggle() {
  const canThink = currentModel()?.capabilities.includes("thinking") ?? false;
  els.thinkWrap.hidden = !canThink;
}

async function loadModels() {
  try {
    const cfg = await fetch("/config").then((r) => r.json());
    els.tokenWrap.hidden = !cfg.authRequired;
    if (cfg.authRequired) els.settings.hidden = false;

    const r = await fetch("/api/models", { headers: authHeaders() });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
    models = data;
    els.model.replaceChildren(...models.map((m) => new Option(m.name, m.name)));
    if (models.some((m) => m.name === cfg.defaultModel)) els.model.value = cfg.defaultModel;
    if (!models.length) showError("No local model found. Run: ollama pull <model>");
    updateThinkToggle();
  } catch (err) {
    showError(`Could not load models: ${err.message}`);
  }
}

// Sending messages

async function send(text) {
  showError("");
  const userMsg = { role: "user", content: text };
  history.push(userMsg);
  const userBubble = addUserBubble(text);
  const ui = addAssistantBubble();

  const messages = [...history];
  const system = els.system.value.trim();
  if (system) messages.unshift({ role: "system", content: system });

  const body = {
    model: els.model.value,
    messages,
    stream: true,
    options: { temperature: Number(els.temperature.value) },
  };
  if (!els.thinkWrap.hidden) body.think = els.think.checked;

  let answer = "";
  let thinking = "";
  controller = new AbortController();
  setBusy(true);

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error ?? `HTTP ${response.status}`);
    }

    for await (const chunk of readNDJSON(response)) {
      if (chunk.error) throw new Error(chunk.error);
      if (chunk.message?.thinking) {
        thinking += chunk.message.thinking;
        ui.thinking.hidden = false;
        ui.thinkingText.textContent = thinking;
      }
      if (chunk.message?.content) {
        answer += chunk.message.content;
        renderContent(ui.content, answer);
      }
      if (chunk.done && chunk.eval_count && chunk.eval_duration) {
        const tps = chunk.eval_count / (chunk.eval_duration / 1e9);
        ui.stats.textContent = `${chunk.eval_count} tokens · ${tps.toFixed(1)} tokens/s`;
      }
      scrollToBottom();
    }
    history.push({ role: "assistant", content: answer });
  } catch (err) {
    if (err.name === "AbortError") {
      history.push({ role: "assistant", content: answer });
      ui.stats.textContent = "Stopped.";
    } else {
      history.splice(history.indexOf(userMsg));
      userBubble.remove();
      ui.div.remove();
      showError(err.message);
      els.input.value = text;
    }
  } finally {
    controller = null;
    setBusy(false);
    els.input.focus();
  }
}

// Events

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  if (!text || controller) return;
  els.input.value = "";
  send(text);
});

els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    els.form.requestSubmit();
  }
});

els.stop.addEventListener("click", () => controller?.abort());

els.newChat.addEventListener("click", () => {
  history = [];
  els.messages.replaceChildren();
  showError("");
  els.input.focus();
});

els.model.addEventListener("change", updateThinkToggle);
els.temperature.addEventListener("input", () => (els.tempValue.textContent = els.temperature.value));
els.settingsToggle.addEventListener("click", () => {
  els.settings.hidden = !els.settings.hidden;
  els.settingsToggle.setAttribute("aria-expanded", String(!els.settings.hidden));
});
els.token.addEventListener("change", loadModels);

loadModels();
