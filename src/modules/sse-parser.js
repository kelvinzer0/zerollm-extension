/**
 * ZeroLLM — SSE Stream Parser & URL Matcher Helper
 */

export function isAiStreamUrl(url) {
  if (!url || typeof url !== "string") return false;
  // Ignore non-stream list/metadata queries
  if (/[?&](?:pageSize|filterIsStarred|excludeProjects)=/i.test(url)) return false;
  if (/\/load-responses|\/sharing\?/i.test(url)) return false;

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
    // VulcanLabs / ChatSmith (/agent-gateway-sse/api/v1/runs/.../stream)
    /(?:vulcanlabs\.co|chatsmith\.io)\/.*(?:stream|runs)/i,
    // Perplexity
    /\/rest\/sse\/perplexity_ask/i,
    /\/rest\/threads\/[^/]+\/followup/i,
    /\/rest\/sse\//i,
    // Grok
    /\/rest\/app-chat\/conversations\/[^/]+\/(?:responses|response-node)/i,
    // Dola AI / Doubao (/chat/completion, /api/chat, /ChatService/Chat)
    /\/chat\/completion/i,
    /\/api\/chat/i,
    /\/ChatService\/Chat/i,
    // ChatGLM / Zhipu AI
    /\/chatglm\/(?:mainchat|backend|chat)-api\//i,
    // WebSocket endpoints (Kimi, Poe, Copilot)
    /(?:kimi\.ai|moonshot\.cn|poe\.com|sydney\.bing\.com)\/.*(?:ws|ChatHub)/i,
    // General heuristic
    /(?:chat_stream|chat\/stream|chat\/completions)/i
  ];
  return patterns.some((p) => p.test(url));
}

export function isStreamCompleted(payload, parsed, currentEvent = "") {
  if (payload === "[DONE]") return true;

  const ev = (currentEvent || "").toLowerCase();
  if (ev === "finish" || ev === "close" || ev === "message_stop" || ev === "done" || ev === "stream.done" || ev === "end_of_stream" || ev === "sse_reply_end" || ev === "all_done") {
    return true;
  }

  if (parsed && typeof parsed === "object") {
    // VulcanLabs / ChatSmith
    if (parsed.event_type === "stream.done" || parsed.event_type === "done") return true;

    // Grok
    if (parsed.result?.response?.modelResponse?.isComplete === true || parsed.result?.response?.isComplete === true) return true;

    // Kimi WebSocket
    if (parsed.event === "all_done" || parsed.event === "finish") return true;

    // Perplexity
    if (parsed.final_sse_message === true || parsed.final === true) return true;
    if (parsed.text_completed === true && parsed.status === "COMPLETED") return true;

    // Dola / Doubao
    if (parsed.end_type !== undefined) return true;
    if (parsed.is_finish === true || parsed.is_finish === "1") return true;

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

  // 8. Dola AI / Doubao format
  // STREAM_MSG_NOTIFY initial text
  if (dataObj.content?.content_block && Array.isArray(dataObj.content.content_block)) {
    const text = dataObj.content.content_block[0]?.content?.text_block?.text;
    if (typeof text === "string" && text) {
      state.lastText = text;
      return { delta: text, full: state.lastText };
    }
  }
  // STREAM_CHUNK incremental patch
  if (dataObj.patch_op && Array.isArray(dataObj.patch_op)) {
    let dolaDelta = "";
    for (const op of dataObj.patch_op) {
      const tb = op.patch_value?.content_block?.[0]?.content?.text_block;
      if (tb && typeof tb.text === "string" && tb.text) {
        dolaDelta += tb.text;
      }
    }
    if (dolaDelta) {
      state.lastText += dolaDelta;
      return { delta: dolaDelta, full: state.lastText };
    }
  }

  // 9. Perplexity format (diff_block patches or workflow_block)
  if (dataObj.blocks && Array.isArray(dataObj.blocks)) {
    for (const block of dataObj.blocks) {
      // Diff block incremental chunks
      if (block.diff_block?.patches && Array.isArray(block.diff_block.patches)) {
        for (const patch of block.diff_block.patches) {
          if (patch.path && typeof patch.path === "string" && patch.path.includes("chunks") && typeof patch.value === "string") {
            const delta = patch.value;
            state.lastText += delta;
            return { delta, full: state.lastText };
          }
          if (patch.path && typeof patch.path === "string" && patch.path.includes("text") && typeof patch.value === "string") {
            const full = patch.value;
            const delta = full.startsWith(state.lastText) ? full.slice(state.lastText.length) : (full === state.lastText ? "" : full);
            state.lastText = full;
            return { delta, full };
          }
          if (patch.value?.steps?.[0]?.items?.[0]?.payload?.text_payload) {
            const tp = patch.value.steps[0].items[0].payload.text_payload;
            if (Array.isArray(tp.chunks) && tp.chunks.length > 0) {
              const full = tp.chunks.join("");
              const delta = full.startsWith(state.lastText) ? full.slice(state.lastText.length) : (full === state.lastText ? "" : full);
              state.lastText = full;
              return { delta, full };
            }
          }
        }
      }
      // Workflow block final or full text
      if (block.workflow_block?.steps?.[0]?.items?.[0]?.payload?.text_payload?.text) {
        const full = block.workflow_block.steps[0].items[0].payload.text_payload.text;
        const delta = full.startsWith(state.lastText) ? full.slice(state.lastText.length) : (full === state.lastText ? "" : full);
        state.lastText = full;
        return { delta, full };
      }
    }
  }

  // 10. Grok web format (NDJSON / result.response.token or result.response.modelResponse)
  if (dataObj.result && typeof dataObj.result === "object") {
    const res = dataObj.result.response;
    if (res && typeof res === "object") {
      if (typeof res.token === "string" && res.token) {
        state.lastText += res.token;
        return { delta: res.token, full: state.lastText };
      }
      const msg = res.modelResponse?.message || res.message;
      if (typeof msg === "string" && msg) {
        const delta = msg.startsWith(state.lastText)
          ? msg.slice(state.lastText.length)
          : (msg === state.lastText ? "" : msg);
        state.lastText = msg;
        return { delta, full: state.lastText };
      }
    }
  }

  // 11. Generic text / content field
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
