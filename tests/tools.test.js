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

test("safeParseJsonArgs correctly parses unescaped HTML/code in content field", () => {
  const userCase = '{"filePath":"/home/kelvinandriancom/chess-project/index.html","content":"<!DOCTYPE html>\\n<html lang="en">\\n<head>\\n <meta charset="UTF-8">\\n <title>Chess Game</title>\\n</head>\\n<body>\\n <div class="container">\\n <h1>Chess Game</h1>\\n </div>\\n</body>\\n</html>"}';
  const parsedStr = safeParseJsonArgs(userCase, "write");
  const parsed = JSON.parse(parsedStr);

  assert.equal(parsed.filePath, "/home/kelvinandriancom/chess-project/index.html");
  assert.ok(parsed.content.includes('<html lang="en">'));
  assert.ok(parsed.content.includes('<meta charset="UTF-8">'));
  assert.ok(parsed.content.includes('<h1>Chess Game</h1>'));
});

test("safeParseJsonArgs normalizes autolinked URLs to clean URLs", () => {
  const userCase = '{"url":"[https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.10.3/chess.min.js\\">](https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.10.3/chess.min.js\\">)"}';
  const parsed = JSON.parse(safeParseJsonArgs(userCase, "test"));
  assert.equal(parsed.url, "https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.10.3/chess.min.js");

  const htmlCase = '{"filePath":"index.html","content":"<script src=\\"[https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.10.3/chess.min.js](https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.10.3/chess.min.js)\\">"}';
  const parsedHtml = JSON.parse(safeParseJsonArgs(htmlCase, "write"));
  assert.equal(parsedHtml.content, '<script src="https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.10.3/chess.min.js">');
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
