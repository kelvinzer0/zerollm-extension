import test from "node:test";
import assert from "node:assert/strict";
import { isAiStreamUrl, extractTextFromSseJson } from "../src/modules/sse-parser.js";

test("isAiStreamUrl correctly identifies AI stream endpoints", () => {
  assert.equal(isAiStreamUrl("https://chatgpt.com/backend-api/conversation"), true);
  assert.equal(isAiStreamUrl("https://chatgpt.com/backend-api/lat/r"), true);
  assert.equal(isAiStreamUrl("https://claude.ai/api/organizations/123/chat_conversations/456/completion"), true);
  assert.equal(isAiStreamUrl("https://chat.qwen.ai/api/v2/chat/completions?chat_id=abc"), true);
  assert.equal(isAiStreamUrl("https://chat.deepseek.com/api/v0/chat/completion"), true);
  assert.equal(isAiStreamUrl("https://www.perplexity.ai/rest/threads/abc/followup"), true);
  assert.equal(isAiStreamUrl("https://grok.com/rest/app-chat/conversations/xyz/responses"), true);
  assert.equal(isAiStreamUrl("https://api.kimi.com/ChatService/Chat"), true);

  // Non-AI regular URLs
  assert.equal(isAiStreamUrl("https://google.com/search?q=test"), false);
  assert.equal(isAiStreamUrl("https://cdn.example.com/assets/app.js"), false);
  assert.equal(isAiStreamUrl(""), false);
  assert.equal(isAiStreamUrl(null), false);
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
