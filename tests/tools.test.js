import test from "node:test";
import assert from "node:assert/strict";
import {
  safeParseJsonArgs,
  parseToolCalls,
  formatMessagesToPrompt,
  formatToolResultToXml,
  stripZeroLlmTags,
  hasUnclosedToolTag,
  autoCloseToolTagsIfNeeded,
  parseDsmlInvokes,
  repackDsmlToZeroLlm
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

test("formatMessagesToPrompt wraps tools in <zerollm_available_tools>", () => {
  const messages = [
    { role: "user", content: "Check directory" }
  ];
  const tools = [
    {
      type: "function",
      function: {
        name: "bash",
        description: "Execute bash commands",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" }
          }
        }
      }
    }
  ];
  const prompt = formatMessagesToPrompt(messages, tools);
  assert.ok(prompt.includes("<zerollm_available_tools>"));
  assert.ok(prompt.includes("1. bash(command) (Execute bash commands)"));
  assert.ok(prompt.includes("</zerollm_available_tools>"));
  assert.ok(!prompt.includes("Fungsi/Tools eksternal yang tersedia:"));
});

test("formatToolResultToXml converts tool output into semantic XML", () => {
  const result = { stdout: "hello from shell", exitCode: 0 };
  const xml = formatToolResultToXml(result, "bash");
  assert.ok(xml.includes("<status>success</status>"));
  assert.ok(xml.includes("<stdout>"));
  assert.ok(xml.includes("hello from shell"));
});

test("stripZeroLlmTags strips assistant and available_tools tags", () => {
  const raw = "<zerollm_available_tools>1. bash()</zerollm_available_tools><zerollm_assistant>\nHello!\n</zerollm_assistant>";
  assert.equal(stripZeroLlmTags(raw), "Hello!");
});

test("hasUnclosedToolTag detects unclosed tool tags accurately", () => {
  assert.equal(hasUnclosedToolTag('<zerollm_tool_call name="write">{"filePath":"test.txt"}'), true);
  assert.equal(hasUnclosedToolTag('<zerollm_tool_call name="write">{"filePath":"test.txt"}</zerollm_tool_call>'), false);
  assert.equal(hasUnclosedToolTag('<tool_call>{"command":"ls"}'), true);
  assert.equal(hasUnclosedToolTag('<tool_call>{"command":"ls"}</tool_call>'), false);
  assert.equal(hasUnclosedToolTag("Teks biasa tanpa tag tool apapun"), false);
});

test("autoCloseToolTagsIfNeeded repairs truncated tool calls to allow JSON parsing", () => {
  const truncated = '<zerollm_tool_call name="write">{"filePath":"/tmp/test.js","content":"ok"}';
  assert.equal(hasUnclosedToolTag(truncated), true);

  const repaired = autoCloseToolTagsIfNeeded(truncated);
  assert.ok(repaired.endsWith("</zerollm_tool_call>"));
  assert.equal(hasUnclosedToolTag(repaired), false);

  const calls = parseToolCalls(repaired);
  assert.ok(calls);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, "write");
  assert.equal(JSON.parse(calls[0].function.arguments).filePath, "/tmp/test.js");
});

test("parseDsmlInvokes and repackDsmlToZeroLlm handle DeepSeek DSML toolcall format", () => {
  const dsml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="bash">
<｜｜DSML｜｜ parameter name="command" string="true">ps aux | grep -i vite | grep -v grep; echo '---LOG---'; cat /tmp/vite-dev.log 2>/dev/null | tail -30</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ parameter name="timeout" string="false">15000</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`;

  // 1. Test parseDsmlInvokes
  const invokes = parseDsmlInvokes(dsml);
  assert.equal(invokes.length, 1);
  assert.equal(invokes[0].name, "bash");
  assert.equal(invokes[0].arguments.command, "ps aux | grep -i vite | grep -v grep; echo '---LOG---'; cat /tmp/vite-dev.log 2>/dev/null | tail -30");
  assert.equal(invokes[0].arguments.timeout, 15000);

  // 2. Test repackDsmlToZeroLlm
  const repacked = repackDsmlToZeroLlm(dsml);
  assert.ok(repacked.includes('<zerollm_tool_call name="bash">'));
  assert.ok(repacked.includes('"timeout":15000'));
  assert.ok(repacked.includes("</zerollm_tool_call>"));
  assert.ok(!repacked.includes("<｜｜DSML｜｜"));

  // 3. Test parseToolCalls directly on DSML input
  const toolCalls = parseToolCalls(dsml);
  assert.ok(toolCalls);
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].function.name, "bash");
  const parsedArgs = JSON.parse(toolCalls[0].function.arguments);
  assert.equal(parsedArgs.command, "ps aux | grep -i vite | grep -v grep; echo '---LOG---'; cat /tmp/vite-dev.log 2>/dev/null | tail -30");
  assert.equal(parsedArgs.timeout, 15000);
});

test("repackDsmlToZeroLlm handles multiple invokes and ascii pipes", () => {
  const multi = `<||DSML|| calls>
<||DSML|| invoke name="read_file">
<||DSML|| parameter name="path" string="true">/app/server.js</||DSML|| parameter>
</||DSML|| invoke>
<||DSML|| invoke name="bash">
<||DSML|| parameter name="command" string="true">node /app/server.js</||DSML|| parameter>
<||DSML|| parameter name="timeout" string="false">3000</||DSML|| parameter>
</||DSML|| invoke>
</||DSML|| calls>`;

  const repacked = repackDsmlToZeroLlm(multi);
  assert.ok(repacked.includes('<zerollm_tool_call name="read_file">{"path":"/app/server.js"}</zerollm_tool_call>'));
  assert.ok(repacked.includes('<zerollm_tool_call name="bash">{"command":"node /app/server.js","timeout":3000}</zerollm_tool_call>'));

  const calls = parseToolCalls(multi);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].function.name, "read_file");
  assert.equal(calls[1].function.name, "bash");
});

test("hasUnclosedToolTag and autoCloseToolTagsIfNeeded support DSML tags", () => {
  const unclosed = `<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="bash">\n<｜｜DSML｜｜ parameter name="command" string="true">uname -a`;
  assert.equal(hasUnclosedToolTag(unclosed), true);

  const closed = autoCloseToolTagsIfNeeded(unclosed);
  assert.equal(hasUnclosedToolTag(closed), false);

  const calls = parseToolCalls(closed);
  assert.ok(calls);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, "bash");
  assert.equal(JSON.parse(calls[0].function.arguments).command, "uname -a");
});

