import test from "node:test";
import assert from "node:assert/strict";
import {
  shouldWrapCommand,
  wrapLinuxBackgroundCommand,
  enrichToolCallsWithWrapper
} from "../src/modules/shell-wrapper.js";

test("shouldWrapCommand detects long running servers and daemon patterns", () => {
  // Long running dev servers
  assert.equal(shouldWrapCommand("exec", { command: "npm run dev" }), true);
  assert.equal(shouldWrapCommand("bash", { command: "yarn start" }), true);
  assert.equal(shouldWrapCommand("terminal", { command: "python -m http.server 8000" }), true);
  assert.equal(shouldWrapCommand("exec", { command: "python app.py" }), true);
  assert.equal(shouldWrapCommand("exec", { command: "docker compose up" }), true);
  assert.equal(shouldWrapCommand("exec", { command: "tail -f app.log" }), true);
  assert.equal(shouldWrapCommand("bash", { command: "nohup ./worker &" }), true);

  // Explicit background flag
  assert.equal(shouldWrapCommand("exec", { command: "custom_job", background: true }), true);
  assert.equal(shouldWrapCommand("bash", { command: "build_script", is_background: true }), true);

  // Standard sync commands (should NOT wrap)
  assert.equal(shouldWrapCommand("exec", { command: "ls -la" }), false);
  assert.equal(shouldWrapCommand("bash", { command: "git status" }), false);
  assert.equal(shouldWrapCommand("sh", { command: "pwd" }), false);
  assert.equal(shouldWrapCommand("cmd", { command: "cat package.json" }), false);

  // Non-shell tools
  assert.equal(shouldWrapCommand("write", { filePath: "index.html", content: "..." }), false);
  assert.equal(shouldWrapCommand("read", { path: "main.py" }), false);
});

test("wrapLinuxBackgroundCommand generates valid native background subshell wrapper", () => {
  const wrapped = wrapLinuxBackgroundCommand("npm run dev");
  assert.ok(wrapped.includes("LOG_FILE"));
  assert.ok(wrapped.includes("EXIT_FILE"));
  assert.ok(wrapped.includes("PID=$!"));
  assert.ok(wrapped.includes("status"));
  assert.ok(!wrapped.includes("tmux"));
});

test("enrichToolCallsWithWrapper transforms qualifying commands while preserving sync commands", () => {
  const toolCalls = [
    {
      id: "call_1",
      type: "function",
      function: {
        name: "exec",
        arguments: JSON.stringify({ command: "npm run dev" })
      }
    },
    {
      id: "call_2",
      type: "function",
      function: {
        name: "exec",
        arguments: JSON.stringify({ command: "ls -la" })
      }
    }
  ];

  const enriched = enrichToolCallsWithWrapper(toolCalls);

  // call_1 should be wrapped
  const args1 = JSON.parse(enriched[0].function.arguments);
  assert.equal(args1._wrapped_background, true);
  assert.ok(args1.command.includes("LOG_FILE"));
  assert.ok(args1.command.includes("PID=$!"));

  // call_2 should remain untouched
  const args2 = JSON.parse(enriched[1].function.arguments);
  assert.equal(args2.command, "ls -la");
  assert.equal(args2._wrapped_background, undefined);
});
