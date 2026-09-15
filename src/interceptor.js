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

  function isStreamCompleted(payload, parsed, currentEvent = "") {
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
    let completed = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || ""; // simpan sisa baris belum lengkap

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(":")) continue; // komentar SSE

          if (trimmed.startsWith("event:")) {
            currentEvent = trimmed.slice(6).trim();
            if (isStreamCompleted("", null, currentEvent)) {
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
              return;
            }
            continue;
          }

          if (trimmed.startsWith("data:")) {
            const payload = trimmed.slice(5).trim();

            let parsed = null;
            try {
              parsed = JSON.parse(payload);
            } catch (e) {
              parsed = null;
            }

            if (isStreamCompleted(payload, parsed, currentEvent)) {
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
            } else if (payload && !payload.startsWith("{")) {
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
        }
      }

      if (!completed) {
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
      let completed = false;

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
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith(":")) continue;

              if (trimmed.startsWith("event:")) {
                currentEvent = trimmed.slice(6).trim();
                if (isStreamCompleted("", null, currentEvent)) {
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
                  return;
                }
                continue;
              }

              if (trimmed.startsWith("data:")) {
                const payload = trimmed.slice(5).trim();

                let parsed = null;
                try {
                  parsed = JSON.parse(payload);
                } catch (e) {
                  parsed = null;
                }

                if (isStreamCompleted(payload, parsed, currentEvent)) {
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
                } else if (payload && !payload.startsWith("{")) {
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
        if (streamId && !completed) {
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
})();
