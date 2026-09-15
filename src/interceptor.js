/**
 * ZeroLLM — Stream Sniffer & Network Interceptor (MAIN World)
 * Runs in page execution context before web scripts load (document_start).
 * Intercepts native window.fetch SSE streams to extract pure, raw text/markdown
 * directly from AI server responses (bypassing DOM, syntax highlighting, & autolinking).
 */

(function () {
  if (window.__ZEROLLM_INTERCEPTOR_INSTALLED__) return;
  window.__ZEROLLM_INTERCEPTOR_INSTALLED__ = true;

  console.log("[ZeroLLM Interceptor] 🚀 Native stream interceptor initialized in MAIN world");

  const originalFetch = window.fetch;
  let activeStreamCounter = 0;

  function isAiStreamUrl(url) {
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

  function extractTextFromSseJson(dataObj, state) {
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

  async function processStreamForZeroLLM(stream, url) {
    const streamId = ++activeStreamCounter;
    console.log(`[ZeroLLM Interceptor] 📡 Reading AI stream #${streamId} from: ${url}`);

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

          if (trimmed.startsWith("data:")) {
            const payload = trimmed.slice(5).trim();
            if (payload === "[DONE]") {
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

            try {
              const parsed = JSON.parse(payload);
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
            } catch (e) {
              // Baris data bukan JSON valid, coba kirim raw delta jika berupa teks
              if (payload && !payload.startsWith("{")) {
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
      }

      // Selesai stream
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
      console.log(`[ZeroLLM Interceptor] ✅ AI stream #${streamId} finished (${state.lastText.length} chars)`);
    } catch (err) {
      console.warn(`[ZeroLLM Interceptor] ⚠️ Error reading AI stream #${streamId}:`, err);
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
})();
