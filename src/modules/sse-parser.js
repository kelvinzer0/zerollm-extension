/**
 * ZeroLLM — SSE Stream Parser & URL Matcher Helper
 */

export function isAiStreamUrl(url) {
  if (!url || typeof url !== "string") return false;
  const patterns = [
    // ChatGPT
    /\/backend-api\/(?:conversation|lat\/r)/i,
    // Claude
    /\/api\/(?:organizations\/[^/]+\/)?chat_conversations\/[^/]+\/completion/i,
    // Qwen
    /\/api\/v\d+\/chat\/completions/i,
    // DeepSeek
    /\/api\/v\d+\/chat\/completion/i,
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

export function extractTextFromSseJson(dataObj, state = { lastText: "" }) {
  if (!dataObj || typeof dataObj !== "object") return null;

  // 1. ChatGPT format (cumulative parts array)
  if (dataObj.message && dataObj.message.content && Array.isArray(dataObj.message.content.parts)) {
    const full = dataObj.message.content.parts.join("");
    const delta = full.startsWith(state.lastText)
      ? full.slice(state.lastText.length)
      : (full === state.lastText ? "" : full);
    state.lastText = full;
    return { delta, full };
  }

  // 2. OpenAI-compatible standard delta format (incremental: choices[0].delta.content)
  if (dataObj.choices && Array.isArray(dataObj.choices) && dataObj.choices[0]) {
    const choice = dataObj.choices[0];
    const delta = choice.delta?.content ?? choice.text ?? "";
    if (delta) {
      state.lastText += delta;
      return { delta, full: state.lastText };
    }
  }

  // 3. Claude format (completion or content_block_delta)
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

  // 4. Qwen / Aliyun format
  if (dataObj.output && typeof dataObj.output.text === "string") {
    const full = dataObj.output.text;
    const delta = full.startsWith(state.lastText)
      ? full.slice(state.lastText.length)
      : (full === state.lastText ? "" : full);
    state.lastText = full;
    return { delta, full };
  }

  // 5. Generic text field
  if (typeof dataObj.text === "string") {
    const delta = dataObj.text;
    state.lastText += delta;
    return { delta, full: state.lastText };
  }

  return null;
}
