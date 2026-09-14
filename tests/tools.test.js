import test from "node:test";
import assert from "node:assert/strict";
import {
  safeParseJsonArgs,
  parseToolCalls,
  formatMessagesToPrompt,
  formatToolResultToXml,
  stripZeroLlmTags
} from "../src/modules/tools.js";

test("safeParseJsonArgs parses valid and slightly malformed JSON", () => {
  assert.equal(safeParseJsonArgs('{"a": 1}', "test"), '{"a":1}');
  assert.equal(safeParseJsonArgs("{'a': 1}", "test"), '{"a":1}');
  assert.equal(safeParseJsonArgs("ls -la", "bash"), '{"command":"ls -la"}');
  assert.equal(safeParseJsonArgs("<zerollm_code>pwd</zerollm_code>", "exec"), '{"command":"pwd"}');
});

test("parseToolCalls detects zerollm_tool_call tag", () => {
  const text = 'Here is the weather: <zerollm_tool_call name="get_weather">{"city": "Jakarta"}</zerollm_tool_call>';
  const calls = parseToolCalls(text);
  assert.ok(calls);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, "get_weather");
  assert.equal(JSON.parse(calls[0].function.arguments).city, "Jakarta");
});

test("parseToolCalls detects XML function parameter format", () => {
  const text = '<tool_call><function=read><parameter=path>/tmp/test.txt</parameter></function></tool_call>';
  const calls = parseToolCalls(text);
  assert.ok(calls);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, "read");
  assert.equal(JSON.parse(calls[0].function.arguments).path, "/tmp/test.txt");
});

test("formatMessagesToPrompt wraps messages in ZeroLLM tags", () => {
  const messages = [
    { role: "system", content: "You are an assistant." },
    { role: "user", content: "Hello world" }
  ];
  const prompt = formatMessagesToPrompt(messages);
  assert.ok(prompt.includes("<zerollm_system>"));
  assert.ok(prompt.includes("<zerollm_user>"));
  assert.ok(prompt.includes("Hello world"));
});

test("formatToolResultToXml converts tool output into semantic XML", () => {
  const result = { stdout: "hello from shell", exitCode: 0 };
  const xml = formatToolResultToXml(result, "bash");
  assert.ok(xml.includes("<status>success</status>"));
  assert.ok(xml.includes("<stdout>"));
  assert.ok(xml.includes("hello from shell"));
});

test("stripZeroLlmTags strips assistant tags", () => {
  const raw = "<zerollm_assistant>\nHello!\n</zerollm_assistant>";
  assert.equal(stripZeroLlmTags(raw), "Hello!");
});
