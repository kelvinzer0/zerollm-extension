/**
 * ZeroLLM — SSE Stream Parser & URL Matcher Helper
 */

export function isAiStreamUrl(url) {
  if (!url || typeof url !== "string") return false;
  const patterns = [
    // ChatGPT (handles /backend-api/conversation, /backend-api/f/conversation, /backend-api/lat/r)
    /\/backend-api\/(?:[a-z0-9_-]+\/)?(?:conversation|lat\/r)/i,
    // Claude
    /\/api\/(?:organizations\/[^/]+\/)?chat_conversations\/[^/]+\/(?:completion|retry_completion)/i,
    // DeepSeek (/api/v0/chat/completion, /api/v1/chat/completion, etc.)
    /\/api\/v\d+\/chat\/completion/i,
    // Xiaomi MiMo (/open-apis/bot/chat, etc.)
    /\/open-apis\/bot\/chat/i,
    // Qwen
    /\/api\/v\d+\/chat\/completions/i,
    // Perplexity
    /\/rest\/threads\/[^/]+\/followup/i,
    // Grok
    /\/rest\/app-chat\/conversations\/[^/]+\/responses/i,
    // Doubao & Kimi
    /\/api\/chat/i,
    /\/ChatService\/Chat/i,
    // General heuristic
    /(?:conversation|completions|chat_stream|chat\/stream)/i
  ];
  return patterns.some((p) => p.test(url));
}

export function isStreamCompleted(payload, parsed, currentEvent = "") {
  if (payload === "[DONE]") return true;

  const ev = (currentEvent || "").toLowerCase();
  if (ev === "finish" || ev === "close" || ev === "message_stop" || ev === "done") {
    return true;
  }

  if (parsed && typeof parsed === "object") {
    // Xiaomi MiMo
    if (parsed.content === "[DONE]") return true;

    // Claude
    if (parsed.type === "message_stop") return true;
    if (parsed.delta?.stop_reason) return true;

    // ChatGPT
    if (parsed.type === "message_marker" && parsed.marker === "last_token") return true;
    if (parsed.p === "/message/status" && parsed.v === "finished_successfully") return true;
    if (parsed.o === "patch" && Array.isArray(parsed.v)) {
      if (parsed.v.some(op => (op.p === "/message/status" && op.v === "finished_successfully") || op.v?.finish_details)) {
        return true;
      }
    }

    // DeepSeek
    if (parsed.p === "response/status" && parsed.v === "FINISHED") return true;
    if (parsed.p === "response" && parsed.o === "BATCH" && Array.isArray(parsed.v)) {
      if (parsed.v.some(op => op.p === "quasi_status" && op.v === "FINISHED")) return true;
    }

    // OpenAI standard
    if (parsed.choices?.[0]?.finish_reason) return true;
  }

  return false;
}

export function extractTextFromSseJson(dataObj, state = { lastText: "" }) {
  if (!dataObj || typeof dataObj !== "object") return null;

  // 1. ChatGPT RFC 6902 JSON Patch format (New ChatGPT web architecture)
  if (dataObj.o === "patch" && Array.isArray(dataObj.v)) {
    let patchDelta = "";
    for (const op of dataObj.v) {
      if (op.p && typeof op.p === "string" && op.p.includes("/message/content/parts/") && typeof op.v === "string") {
        if (op.o === "append") {
          patchDelta += op.v;
        } else if (op.o === "replace") {
          const delta = op.v.startsWith(state.lastText) ? op.v.slice(state.lastText.length) : op.v;
          patchDelta += delta;
        }
      }
    }
    if (patchDelta) {
      state.lastText += patchDelta;
      return { delta: patchDelta, full: state.lastText };
    }
  }

  if (dataObj.p && typeof dataObj.p === "string" && dataObj.p.includes("/message/content/parts/") && typeof dataObj.v === "string") {
    let patchDelta = "";
    if (dataObj.o === "append") {
      patchDelta = dataObj.v;
    } else if (dataObj.o === "replace") {
      patchDelta = dataObj.v.startsWith(state.lastText) ? dataObj.v.slice(state.lastText.length) : dataObj.v;
    }
    if (patchDelta) {
      state.lastText += patchDelta;
      return { delta: patchDelta, full: state.lastText };
    }
  }

  // 2. ChatGPT Legacy format (cumulative parts array)
  if (dataObj.message && dataObj.message.content && Array.isArray(dataObj.message.content.parts)) {
    const full = dataObj.message.content.parts.join("");
    const delta = full.startsWith(state.lastText)
      ? full.slice(state.lastText.length)
      : (full === state.lastText ? "" : full);
    state.lastText = full;
    return { delta, full };
  }

  // 3. DeepSeek Web format
  // Initial fragments: {"v":{"response":{"fragments":[{"content":"H"}]}}}
  if (dataObj.v && typeof dataObj.v === "object" && dataObj.v.response?.fragments && Array.isArray(dataObj.v.response.fragments)) {
    const initialText = dataObj.v.response.fragments.map(f => f.content || "").join("");
    if (initialText && !state.lastText) {
      state.lastText = initialText;
      return { delta: initialText, full: state.lastText };
    }
  }
  // DeepSeek incremental token: {"v":"!"} or {"p":"response/fragments/-1/content","o":"APPEND","v":"alo"}
  if (typeof dataObj.v === "string" && dataObj.v !== "FINISHED") {
    const delta = dataObj.v;
    state.lastText += delta;
    return { delta, full: state.lastText };
  }

  // 4. Xiaomi MiMo format: {"type":"text","content":"..."}
  if (dataObj.type === "text" && typeof dataObj.content === "string") {
    const cleaned = dataObj.content.replace(/\u0000/g, "");
    if (cleaned) {
      state.lastText += cleaned;
      return { delta: cleaned, full: state.lastText };
    }
  }

  // 5. OpenAI-compatible standard delta format (incremental: choices[0].delta.content)
  if (dataObj.choices && Array.isArray(dataObj.choices) && dataObj.choices[0]) {
    const choice = dataObj.choices[0];
    const delta = choice.delta?.content ?? choice.text ?? "";
    if (delta) {
      state.lastText += delta;
      return { delta, full: state.lastText };
    }
  }

  // 6. Claude format (completion or content_block_delta)
  if (typeof dataObj.completion === "string") {
    const delta = dataObj.completion;
    state.lastText += delta;
    return { delta, full: state.lastText };
  }
  if (dataObj.type === "content_block_delta" && dataObj.delta && typeof dataObj.delta.text === "string") {
    const delta = dataObj.delta.text;
    state.lastText += delta;
    return { delta, full: state.lastText };
  }
  if (dataObj.delta?.type === "text_delta" && typeof dataObj.delta?.text === "string") {
    const delta = dataObj.delta.text;
    state.lastText += delta;
    return { delta, full: state.lastText };
  }
  if (dataObj.type === "text_delta" && typeof dataObj.text === "string") {
    const delta = dataObj.text;
    state.lastText += delta;
    return { delta, full: state.lastText };
  }

  // 7. Qwen / Aliyun format
  if (dataObj.output && typeof dataObj.output.text === "string") {
    const full = dataObj.output.text;
    const delta = full.startsWith(state.lastText)
      ? full.slice(state.lastText.length)
      : (full === state.lastText ? "" : full);
    state.lastText = full;
    return { delta, full };
  }

  // 8. Generic text / content field
  if (typeof dataObj.text === "string") {
    const delta = dataObj.text;
    state.lastText += delta;
    return { delta, full: state.lastText };
  }
  if (typeof dataObj.content === "string" && dataObj.content !== "[DONE]") {
    const delta = dataObj.content;
    state.lastText += delta;
    return { delta, full: state.lastText };
  }

  return null;
}
