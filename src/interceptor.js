/**
 * ZeroLLM — Stream Sniffer & Network Interceptor (MAIN World)
 * Runs in page execution context before web scripts load (document_start).
 * Intercepts native window.fetch AND XMLHttpRequest SSE streams to extract pure, raw text/markdown
 * directly from AI server responses (bypassing DOM, syntax highlighting, & autolinking).
 */

(function () {
  if (window.__ZEROLLM_INTERCEPTOR_INSTALLED__) return;
  window.__ZEROLLM_INTERCEPTOR_INSTALLED__ = true;

  console.log("[ZeroLLM Interceptor] 🚀 Native stream interceptor initialized in MAIN world (Fetch + XHR)");

  const originalFetch = window.fetch;
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;
  let activeStreamCounter = 0;

  function isAiStreamUrl(url) {
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

  function isStreamCompleted(payload, parsed, currentEvent = "") {
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

  function extractTextFromSseJson(dataObj, state) {
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

  // Helper to dispatch SSE event payload to ZeroLLM content script
  function dispatchEventPayload(payload, currentEvent, state, streamId, url, onCompleted) {
    if (isStreamCompleted(payload, null, currentEvent)) {
      onCompleted();
      return;
    }

    let parsed = null;
    try {
      parsed = JSON.parse(payload);
    } catch (e) {
      parsed = null;
    }

    if (isStreamCompleted(payload, parsed, currentEvent)) {
      onCompleted();
      return;
    }

    if (parsed) {
      const extracted = extractTextFromSseJson(parsed, state);
      if (extracted && extracted.delta) {
        window.postMessage(
          {
            source: "zerollm_interceptor",
            event: "stream_delta",
            streamId,
            delta: extracted.delta,
            fullText: extracted.full,
            url
          },
          "*"
        );
      }
    } else if (payload.length > 0 && !payload.startsWith("{")) {
      // Raw text token (ChatSmith / VulcanLabs, plain text SSE)
      // Preserves all whitespace, indentation, and newlines!
      state.lastText += payload;
      window.postMessage(
        {
          source: "zerollm_interceptor",
          event: "stream_delta",
          streamId,
          delta: payload,
          fullText: state.lastText,
          url
        },
        "*"
      );
    }
  }

  // ── 1. Fetch SSE Stream Interception ──
  async function processStreamForZeroLLM(stream, url) {
    const streamId = ++activeStreamCounter;
    console.log(`[ZeroLLM Interceptor] 📡 Reading AI fetch stream #${streamId} from: ${url}`);

    window.postMessage(
      {
        source: "zerollm_interceptor",
        event: "stream_start",
        streamId,
        url
      },
      "*"
    );

    const reader = stream.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    const state = { lastText: "" };
    let currentEvent = "";
    let dataBuffer = "";
    let completed = false;

    const handleCompleted = () => {
      if (completed) return;
      completed = true;
      window.postMessage(
        {
          source: "zerollm_interceptor",
          event: "stream_end",
          streamId,
          fullText: state.lastText,
          url
        },
        "*"
      );
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || ""; // simpan sisa baris belum lengkap

        for (const line of lines) {
          if (line === "") {
            // W3C SSE standard: Blank line dispatches the accumulated event
            if (dataBuffer.length > 0) {
              const payload = dataBuffer.endsWith("\n") ? dataBuffer.slice(0, -1) : dataBuffer;
              dataBuffer = "";
              dispatchEventPayload(payload, currentEvent, state, streamId, url, handleCompleted);
              currentEvent = "";
              if (completed) return;
            }
            continue;
          }

          if (line.startsWith(":")) continue; // komentar SSE

          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).replace(/^ /, "").trim();
            if (isStreamCompleted("", null, currentEvent)) {
              handleCompleted();
              return;
            }
            continue;
          }

          if (line.startsWith("data:")) {
            // W3C SSE standard: Strip only the single leading space after 'data:'
            const val = line.slice(5).replace(/^ /, "");
            dataBuffer += val + "\n";
            continue;
          }

          // NDJSON lines (e.g. Grok, ChatGPT lat/r where line begins directly with { and ends with })
          if (line.startsWith("{") && line.endsWith("}")) {
            dispatchEventPayload(line, currentEvent, state, streamId, url, handleCompleted);
            if (completed) return;
          }
        }
      }

      // Flush any trailing event if stream closed without trailing newline
      if (dataBuffer.length > 0 && !completed) {
        const payload = dataBuffer.endsWith("\n") ? dataBuffer.slice(0, -1) : dataBuffer;
        dataBuffer = "";
        dispatchEventPayload(payload, currentEvent, state, streamId, url, handleCompleted);
      }

      if (!completed) {
        handleCompleted();
        console.log(`[ZeroLLM Interceptor] ✅ AI fetch stream #${streamId} finished (${state.lastText.length} chars)`);
      }
    } catch (err) {
      console.warn(`[ZeroLLM Interceptor] ⚠️ Error reading AI fetch stream #${streamId}:`, err);
      window.postMessage(
        {
          source: "zerollm_interceptor",
          event: "stream_error",
          streamId,
          error: String(err),
          fullText: state.lastText,
          url
        },
        "*"
      );
    }
  }

  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);

    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
      const contentType = response.headers.get("content-type") || "";
      const isSSE = contentType.includes("text/event-stream");
      const isMatchedUrl = isAiStreamUrl(url);

      if ((isSSE || isMatchedUrl) && response.body && !response.bodyUsed) {
        // Gandakan stream secara transparan menggunakan browser native stream tee()
        const [pageStream, zeroLlmStream] = response.body.tee();

        // Proses cabang zeroLlmStream secara asinkron tanpa memblokir halaman web
        processStreamForZeroLLM(zeroLlmStream, url);

        // Kembalikan Response baru dengan pageStream ke kode web AI
        return new Response(pageStream, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        });
      }
    } catch (interceptionErr) {
      console.warn("[ZeroLLM Interceptor] Failed to tee response body:", interceptionErr);
    }

    return response;
  };

  // ── 2. XMLHttpRequest SSE Stream Interception (e.g. DeepSeek web) ──
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__zerollm_url = typeof url === "string" ? url : String(url);
    this.__zerollm_method = method;
    return originalXhrOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    const url = this.__zerollm_url || "";
    if (isAiStreamUrl(url)) {
      let processedLength = 0;
      let streamId = null;
      let buffer = "";
      const state = { lastText: "" };
      let currentEvent = "";
      let xhrDataBuffer = "";
      let completed = false;

      const handleCompleted = () => {
        if (completed) return;
        completed = true;
        window.postMessage(
          {
            source: "zerollm_interceptor",
            event: "stream_end",
            streamId,
            fullText: state.lastText,
            url
          },
          "*"
        );
        console.log(`[ZeroLLM Interceptor] ✅ AI XHR stream #${streamId} finished (${state.lastText.length} chars)`);
      };

      const processXhrChunk = () => {
        try {
          const contentType = this.getResponseHeader("content-type") || "";
          if (!contentType.includes("text/event-stream") && !isAiStreamUrl(url)) return;

          if (!streamId) {
            streamId = ++activeStreamCounter;
            console.log(`[ZeroLLM Interceptor] 📡 Reading AI XHR stream #${streamId} from: ${url}`);
            window.postMessage(
              {
                source: "zerollm_interceptor",
                event: "stream_start",
                streamId,
                url
              },
              "*"
            );
          }

          const responseText = this.responseText || "";
          if (responseText.length > processedLength) {
            const chunk = responseText.slice(processedLength);
            processedLength = responseText.length;
            buffer += chunk;
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (line === "") {
                if (xhrDataBuffer.length > 0) {
                  const payload = xhrDataBuffer.endsWith("\n") ? xhrDataBuffer.slice(0, -1) : xhrDataBuffer;
                  xhrDataBuffer = "";
                  dispatchEventPayload(payload, currentEvent, state, streamId, url, handleCompleted);
                  currentEvent = "";
                  if (completed) return;
                }
                continue;
              }

              if (line.startsWith(":")) continue;

              if (line.startsWith("event:")) {
                currentEvent = line.slice(6).replace(/^ /, "").trim();
                if (isStreamCompleted("", null, currentEvent)) {
                  handleCompleted();
                  return;
                }
                continue;
              }

              if (line.startsWith("data:")) {
                const val = line.slice(5).replace(/^ /, "");
                xhrDataBuffer += val + "\n";
                continue;
              }

              if (line.startsWith("{") && line.endsWith("}")) {
                dispatchEventPayload(line, currentEvent, state, streamId, url, handleCompleted);
                if (completed) return;
              }
            }
          }
        } catch (e) {
          // Headers or responseText might throw in early readyStates
        }
      };

      this.addEventListener("progress", processXhrChunk);
      this.addEventListener("readystatechange", () => {
        if (this.readyState >= 3) {
          processXhrChunk();
        }
      });
      this.addEventListener("load", () => {
        processXhrChunk();
        if (xhrDataBuffer.length > 0 && !completed) {
          const payload = xhrDataBuffer.endsWith("\n") ? xhrDataBuffer.slice(0, -1) : xhrDataBuffer;
          xhrDataBuffer = "";
          dispatchEventPayload(payload, currentEvent, state, streamId, url, handleCompleted);
        }
        if (streamId && !completed) {
          handleCompleted();
        }
      });
      this.addEventListener("error", (err) => {
        if (streamId && !completed) {
          window.postMessage(
            {
              source: "zerollm_interceptor",
              event: "stream_error",
              streamId,
              error: "XHR stream network error",
              fullText: state.lastText,
              url
            },
            "*"
          );
        }
      });
    }

    return originalXhrSend.apply(this, args);
  };

  // ── 3. WebSocket Interception (e.g. Kimi AI Global/CN, Poe, Copilot) ──
  const originalWebSocket = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    const ws = protocols !== undefined ? new originalWebSocket(url, protocols) : new originalWebSocket(url);

    try {
      const urlStr = typeof url === "string" ? url : (url?.url || String(url));
      const isAiWs = isAiStreamUrl(urlStr) || /(?:kimi\.ai|moonshot\.cn|poe\.com|sydney\.bing\.com|copilot)/i.test(urlStr);

      if (isAiWs) {
        let streamId = null;
        const state = { lastText: "" };
        let completed = false;

        ws.addEventListener("message", (event) => {
          try {
            if (typeof event.data !== "string") return;
            const dataStr = event.data.trim();
            if (!dataStr) return;

            let parsed = null;
            try {
              parsed = JSON.parse(dataStr);
            } catch (e) {
              parsed = null;
            }

            // Ignore websocket heartbeat / ping-pong
            if (parsed && (parsed.type === "ping" || parsed.type === "pong" || parsed.event === "ping" || parsed.event === "pong")) {
              return;
            }

            if (!streamId && (parsed || dataStr.length > 0)) {
              streamId = ++activeStreamCounter;
              console.log(`[ZeroLLM Interceptor] 📡 Reading AI WebSocket stream #${streamId} from: ${urlStr}`);
              window.postMessage(
                {
                  source: "zerollm_interceptor",
                  event: "stream_start",
                  streamId,
                  url: urlStr
                },
                "*"
              );
            }

            if (isStreamCompleted(dataStr, parsed, "")) {
              if (streamId && !completed) {
                completed = true;
                window.postMessage(
                  {
                    source: "zerollm_interceptor",
                    event: "stream_end",
                    streamId,
                    fullText: state.lastText,
                    url: urlStr
                  },
                  "*"
                );
                console.log(`[ZeroLLM Interceptor] ✅ AI WebSocket stream #${streamId} finished (${state.lastText.length} chars)`);
              }
              return;
            }

            if (parsed) {
              const extracted = extractTextFromSseJson(parsed, state);
              if (extracted && extracted.delta) {
                window.postMessage(
                  {
                    source: "zerollm_interceptor",
                    event: "stream_delta",
                    streamId,
                    delta: extracted.delta,
                    fullText: extracted.full,
                    url: urlStr
                  },
                  "*"
                );
              }
            } else if (!dataStr.startsWith("{")) {
              state.lastText += dataStr;
              window.postMessage(
                {
                  source: "zerollm_interceptor",
                  event: "stream_delta",
                  streamId,
                  delta: dataStr,
                  fullText: state.lastText,
                  url: urlStr
                },
                "*"
              );
            }
          } catch (wsErr) {
            console.warn("[ZeroLLM Interceptor] Error processing WebSocket message frame:", wsErr);
          }
        });

        ws.addEventListener("close", () => {
          if (streamId && !completed) {
            completed = true;
            window.postMessage(
              {
                source: "zerollm_interceptor",
                event: "stream_end",
                streamId,
                fullText: state.lastText,
                url: urlStr
              },
              "*"
            );
          }
        });
      }
    } catch (wsInitErr) {
      console.warn("[ZeroLLM Interceptor] Error wrapping WebSocket:", wsInitErr);
    }

    return ws;
  };

  window.WebSocket.prototype = originalWebSocket.prototype;
  window.WebSocket.CONNECTING = originalWebSocket.CONNECTING;
  window.WebSocket.OPEN = originalWebSocket.OPEN;
  window.WebSocket.CLOSING = originalWebSocket.CLOSING;
  window.WebSocket.CLOSED = originalWebSocket.CLOSED;
})();
