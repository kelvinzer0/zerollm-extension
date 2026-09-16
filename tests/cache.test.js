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

test("processStreamDelta pools initial < and </ until tag is identified", () => {
  const reqId = "test_req_2";
  deleteStreamBuffer(reqId);

  // Chunk 1: ends with bare '<'
  const c1 = processStreamDelta(reqId, "Beginning <");
  assert.equal(c1, "Beginning ");

  // Chunk 2: appends '/zerollm_'
  const c2 = processStreamDelta(reqId, "/zerollm_");
  assert.equal(c2, null);

  // Chunk 3: completes stray closing tag '</zerollm_tool_call>'
  const c3 = processStreamDelta(reqId, "tool_call> and then regular text");
  assert.equal(c3, " and then regular text");
});

test("processStreamDelta converts zerollm_code to clean markdown code blocks", () => {
  const reqId = "test_req_3";
  deleteStreamBuffer(reqId);

  const c1 = processStreamDelta(reqId, 'Here is code: <zerollm_code lang="python">print("hi")</zerollm_code> done!');
  assert.ok(c1.includes("```python"));
  assert.ok(c1.includes('print("hi")'));
  assert.ok(c1.includes("```"));
  assert.ok(!c1.includes("<zerollm_code"));
  assert.ok(!c1.includes("</zerollm_code>"));
});

test("processStreamDelta preserves normal text with mathematical <", () => {
  const reqId = "test_req_4";
  deleteStreamBuffer(reqId);

  const res = processStreamDelta(reqId, "Nilai x < 5 dan y > 2 selesai");
  assert.equal(res, "Nilai x < 5 dan y > 2 selesai");
});

test("processStreamDelta suppresses DeepSeek DSML blocks during streaming", () => {
  const reqId = "test_req_5";
  deleteStreamBuffer(reqId);

  // Chunk 1: Normal preamble text then starts DSML tag
  const c1 = processStreamDelta(reqId, "Saya akan cek proses. <｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name=\"bash\">\n<｜｜DSML｜｜ parameter");
  assert.equal(c1, "Saya akan cek proses. ");

  // Chunk 2: Finishes DSML block then post text
  const c2 = processStreamDelta(reqId, ' name="command" string="true">ps aux</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls> Tunggu sebentar...');
  assert.equal(c2, " Tunggu sebentar...");
});


