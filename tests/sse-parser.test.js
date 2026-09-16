import test from "node:test";
import assert from "node:assert/strict";
import { isAiStreamUrl, extractTextFromSseJson, isStreamCompleted } from "../src/modules/sse-parser.js";

test("isAiStreamUrl correctly identifies AI stream endpoints", () => {
  assert.equal(isAiStreamUrl("https://chatgpt.com/backend-api/conversation"), true);
  assert.equal(isAiStreamUrl("https://chatgpt.com/backend-api/f/conversation"), true);
  assert.equal(isAiStreamUrl("https://chatgpt.com/backend-api/lat/r"), true);
  assert.equal(isAiStreamUrl("https://claude.ai/api/organizations/123/chat_conversations/456/completion"), true);
  assert.equal(isAiStreamUrl("https://chat.qwen.ai/api/v2/chat/completions?chat_id=abc"), true);
  assert.equal(isAiStreamUrl("https://chat.deepseek.com/api/v0/chat/completion"), true);
  assert.equal(isAiStreamUrl("https://aistudio.xiaomimimo.com/open-apis/bot/chat?xiaomichatbot_ph=abc"), true);
  assert.equal(isAiStreamUrl("https://www.perplexity.ai/rest/threads/abc/followup"), true);
  assert.equal(isAiStreamUrl("https://www.perplexity.ai/rest/sse/perplexity_ask"), true);
  assert.equal(isAiStreamUrl("https://grok.com/rest/app-chat/conversations/xyz/responses"), true);
  assert.equal(isAiStreamUrl("https://api.kimi.com/ChatService/Chat"), true);
  assert.equal(isAiStreamUrl("https://www.dola.com/chat/completion?aid=495671"), true);
  assert.equal(isAiStreamUrl("https://chatglm.cn/chatglm/mainchat-api/conversation/stream"), true);

  // Non-AI regular URLs
  assert.equal(isAiStreamUrl("https://google.com/search?q=test"), false);
  assert.equal(isAiStreamUrl("https://cdn.example.com/assets/app.js"), false);
  assert.equal(isAiStreamUrl(""), false);
  assert.equal(isAiStreamUrl(null), false);
});

test("extractTextFromSseJson handles ChatGPT RFC 6902 JSON patch deltas", () => {
  const state = { lastText: "" };

  const chunk1 = {
    o: "patch",
    v: [{ p: "/message/content/parts/0", o: "append", v: "Halo" }]
  };
  const res1 = extractTextFromSseJson(chunk1, state);
  assert.equal(res1.delta, "Halo");
  assert.equal(res1.full, "Halo");

  const chunk2 = {
    p: "/message/content/parts/0",
    o: "append",
    v: " dunia!"
  };
  const res2 = extractTextFromSseJson(chunk2, state);
  assert.equal(res2.delta, " dunia!");
  assert.equal(res2.full, "Halo dunia!");
});

test("extractTextFromSseJson handles DeepSeek Web format", () => {
  const state = { lastText: "" };

  const chunk1 = {
    v: {
      response: {
        fragments: [{ content: "H" }]
      }
    }
  };
  const res1 = extractTextFromSseJson(chunk1, state);
  assert.equal(res1.delta, "H");
  assert.equal(res1.full, "H");

  const chunk2 = {
    p: "response/fragments/-1/content",
    o: "APPEND",
    v: "alo"
  };
  const res2 = extractTextFromSseJson(chunk2, state);
  assert.equal(res2.delta, "alo");
  assert.equal(res2.full, "Halo");

  const chunk3 = { v: "!" };
  const res3 = extractTextFromSseJson(chunk3, state);
  assert.equal(res3.delta, "!");
  assert.equal(res3.full, "Halo!");
});

test("extractTextFromSseJson handles Xiaomi MiMo format and strips null bytes", () => {
  const state = { lastText: "" };

  const chunk1 = {
    type: "text",
    content: "<think>\u0000Thinking..."
  };
  const res1 = extractTextFromSseJson(chunk1, state);
  assert.equal(res1.delta, "<think>Thinking...");
  assert.equal(res1.full, "<think>Thinking...");

  const chunk2 = {
    type: "text",
    content: "</think>\u0000Jawaban"
  };
  const res2 = extractTextFromSseJson(chunk2, state);
  assert.equal(res2.delta, "</think>Jawaban");
  assert.equal(res2.full, "<think>Thinking...</think>Jawaban");
});

test("isStreamCompleted detects completion signals across all platforms", () => {
  // 1. Standard [DONE]
  assert.equal(isStreamCompleted("[DONE]", null), true);

  // 2. Xiaomi MiMo
  assert.equal(isStreamCompleted('{"content":"[DONE]"}', { content: "[DONE]" }, "finish"), true);

  // 3. DeepSeek
  assert.equal(isStreamCompleted("", { p: "response/status", v: "FINISHED" }, "update_session"), true);
  assert.equal(isStreamCompleted("", null, "close"), true);

  // 4. Claude
  assert.equal(isStreamCompleted("", { type: "message_stop" }, "message_stop"), true);
  assert.equal(isStreamCompleted("", { delta: { stop_reason: "end_turn" } }), true);

  // 5. ChatGPT
  assert.equal(isStreamCompleted("", { type: "message_marker", marker: "last_token" }), true);
  assert.equal(isStreamCompleted("", {
    o: "patch",
    v: [{ p: "/message/status", o: "replace", v: "finished_successfully" }]
  }), true);

  // 6. Perplexity
  assert.equal(isStreamCompleted("", null, "end_of_stream"), true);
  assert.equal(isStreamCompleted("", { final_sse_message: true }), true);
  assert.equal(isStreamCompleted("", { text_completed: true, status: "COMPLETED" }), true);

  // 7. Dola AI / Doubao
  assert.equal(isStreamCompleted("", null, "sse_reply_end"), true);
  assert.equal(isStreamCompleted("", { end_type: 1 }), true);
  assert.equal(isStreamCompleted("", { is_finish: true }), true);

  // Ongoing non-final chunk
  assert.equal(isStreamCompleted('{"v":"halo"}', { v: "halo" }, "message"), false);
});

test("extractTextFromSseJson handles ChatGPT cumulative parts", () => {
  const state = { lastText: "" };
  
  const chunk1 = { message: { content: { parts: ["Hello"] } } };
  const res1 = extractTextFromSseJson(chunk1, state);
  assert.equal(res1.delta, "Hello");
  assert.equal(res1.full, "Hello");

  const chunk2 = { message: { content: { parts: ["Hello, world!"] } } };
  const res2 = extractTextFromSseJson(chunk2, state);
  assert.equal(res2.delta, ", world!");
  assert.equal(res2.full, "Hello, world!");
});

test("extractTextFromSseJson handles OpenAI standard incremental deltas", () => {
  const state = { lastText: "" };

  const chunk1 = { choices: [{ delta: { content: "Alpha" } }] };
  const res1 = extractTextFromSseJson(chunk1, state);
  assert.equal(res1.delta, "Alpha");
  assert.equal(res1.full, "Alpha");

  const chunk2 = { choices: [{ delta: { content: " Beta" } }] };
  const res2 = extractTextFromSseJson(chunk2, state);
  assert.equal(res2.delta, " Beta");
  assert.equal(res2.full, "Alpha Beta");
});

test("extractTextFromSseJson handles Claude delta format", () => {
  const state = { lastText: "" };

  const chunk1 = { type: "content_block_delta", delta: { text: "Claude response" } };
  const res1 = extractTextFromSseJson(chunk1, state);
  assert.equal(res1.delta, "Claude response");
  assert.equal(res1.full, "Claude response");

  const chunk2 = { completion: " additional" };
  const res2 = extractTextFromSseJson(chunk2, state);
  assert.equal(res2.delta, " additional");
  assert.equal(res2.full, "Claude response additional");
});

test("extractTextFromSseJson handles Qwen output text", () => {
  const state = { lastText: "" };

  const chunk1 = { output: { text: "Qwen" } };
  const res1 = extractTextFromSseJson(chunk1, state);
  assert.equal(res1.delta, "Qwen");
  assert.equal(res1.full, "Qwen");

  const chunk2 = { output: { text: "Qwen Plus" } };
  const res2 = extractTextFromSseJson(chunk2, state);
  assert.equal(res2.delta, " Plus");
  assert.equal(res2.full, "Qwen Plus");
});

test("extractTextFromSseJson handles Dola AI / Doubao STREAM_MSG_NOTIFY and STREAM_CHUNK", () => {
  const state = { lastText: "" };

  // Initial message notify
  const notifyChunk = {
    content: {
      content_block: [{
        content: { text_block: { text: "Halo" } }
      }]
    }
  };
  const res1 = extractTextFromSseJson(notifyChunk, state);
  assert.equal(res1.delta, "Halo");
  assert.equal(res1.full, "Halo");

  // Incremental patch chunk
  const patchChunk = {
    patch_op: [{
      patch_value: {
        content_block: [{
          content: { text_block: { text: " dari Dola!" } }
        }]
      }
    }]
  };
  const res2 = extractTextFromSseJson(patchChunk, state);
  assert.equal(res2.delta, " dari Dola!");
  assert.equal(res2.full, "Halo dari Dola!");
});

test("extractTextFromSseJson handles Perplexity diff_block patches and workflow_block", () => {
  const state = { lastText: "" };

  // Incremental chunk
  const chunk1 = {
    blocks: [{
      diff_block: {
        patches: [
          { path: "/steps/0/items/0/payload/text_payload/chunks/0", value: "Halo Perplexity" }
        ]
      }
    }]
  };
  const res1 = extractTextFromSseJson(chunk1, state);
  assert.equal(res1.delta, "Halo Perplexity");
  assert.equal(res1.full, "Halo Perplexity");

  // Cumulative text replacement
  const chunk2 = {
    blocks: [{
      diff_block: {
        patches: [
          { path: "/steps/0/items/0/payload/text_payload/text", value: "Halo Perplexity AI!" }
        ]
      }
    }]
  };
  const res2 = extractTextFromSseJson(chunk2, state);
  assert.equal(res2.delta, " AI!");
  assert.equal(res2.full, "Halo Perplexity AI!");
});

test("extractTextFromSseJson handles Grok NDJSON token and message format", () => {
  const state = { lastText: "" };

  const chunk1 = {
    result: {
      response: {
        token: "Hello"
      }
    }
  };
  const res1 = extractTextFromSseJson(chunk1, state);
  assert.equal(res1.delta, "Hello");
  assert.equal(res1.full, "Hello");

  const chunk2 = {
    result: {
      response: {
        token: " from Grok!"
      }
    }
  };
  const res2 = extractTextFromSseJson(chunk2, state);
  assert.equal(res2.delta, " from Grok!");
  assert.equal(res2.full, "Hello from Grok!");
});

test("isAiStreamUrl ignores Grok list conversation queries and matches responses", () => {
  assert.equal(isAiStreamUrl("https://grok.com/rest/app-chat/conversations?pageSize=60"), false);
  assert.equal(isAiStreamUrl("https://grok.com/rest/app-chat/conversations?pageSize=60&excludeProjects=true"), false);
  assert.equal(isAiStreamUrl("https://grok.com/rest/app-chat/conversations/xyz/load-responses"), false);
  assert.equal(isAiStreamUrl("https://grok.com/rest/app-chat/conversations/xyz/responses"), true);
  assert.equal(isAiStreamUrl("https://grok.com/rest/app-chat/conversations/xyz/response-node"), true);
  assert.equal(isAiStreamUrl("wss://notilo.kimi.ai/ws"), true);
});

test("isAiStreamUrl matches ChatSmith and VulcanLabs stream URLs", () => {
  assert.equal(isAiStreamUrl("https://api.vulcanlabs.co/agent-gateway-sse/api/v1/runs/8f87e0a2-71dd-4ad8-af8d-dcfc7ca2f5cb/stream?ticket=01M2MVA1075H4F82KFWEGV3KJS"), true);
  assert.equal(isAiStreamUrl("https://chatsmith.io/api/runs/123/stream"), true);
});

test("isStreamCompleted handles ChatSmith stream.done event and payload", () => {
  assert.equal(isStreamCompleted("", null, "stream.done"), true);
  assert.equal(isStreamCompleted("", { event_type: "stream.done" }, ""), true);
  assert.equal(isStreamCompleted("", { event_type: "done" }, ""), true);
});

