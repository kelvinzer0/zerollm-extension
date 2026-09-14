import test from "node:test";
import assert from "node:assert/strict";
import {
  getFromCache,
  saveToCache,
  processStreamDelta,
  deleteStreamBuffer
} from "../src/modules/cache.js";

test("saveToCache and getFromCache store and retrieve values", () => {
  saveToCache("chatgpt", "What is 2+2?", {
    content: "4",
    tool_calls: null,
    finish_reason: "stop"
  });

  const cached = getFromCache("chatgpt", "What is 2+2?");
  assert.ok(cached);
  assert.equal(cached.content, "4");

  const miss = getFromCache("chatgpt", "Something else");
  assert.equal(miss, null);
});

test("processStreamDelta suppresses unclosed tool tags", () => {
  const reqId = "test_req_1";
  deleteStreamBuffer(reqId);

  // Partial tag incoming
  const chunk1 = processStreamDelta(reqId, "Hello <zerollm_tool_call name=");
  assert.equal(chunk1, "Hello ");

  // Closing arrives
  const chunk2 = processStreamDelta(reqId, '"read">{}</zerollm_tool_call> and goodbye!');
  assert.equal(chunk2, " and goodbye!");
});
