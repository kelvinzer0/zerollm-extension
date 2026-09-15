/**
 * ZeroLLM — Linux Shell Background & Tmux Wrapper Module
 * 
 * Automatically wraps long-running, daemon, or interactive shell tool commands:
 * - Checks `command -v tmux` dynamically at runtime.
 * - If tmux exists: runs in a detached headless tmux session (PTY, interactive, crash-proof).
 * - If tmux is absent: falls back to background subshell with logging and PID recording.
 * - Guarantees output is preserved in `/tmp/*.log` (never lost to /dev/null).
 * - Records PID and exit code for status tracking.
 */

const SHELL_TOOL_NAMES = new Set([
  "exec",
  "bash",
  "sh",
  "shell",
  "cmd",
  "terminal",
  "run_command",
  "run_terminal_command"
]);

const LONG_RUNNING_PATTERNS = [
  // Package manager dev / start servers
  /\b(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?(?:dev|start|serve|watch)\b/i,
  // Python web servers & watchers
  /\bpython\d*\s+(?:-m\s+http\.server|app\.py|server\.py|main\.py|manage\.py\s+runserver)\b/i,
  // Popular dev servers & frameworks
  /\b(?:vite|next|nuxt|astro|gatsby|remix|flask|uvicorn|gunicorn|fastapi)\b/i,
  // Container services
  /\bdocker(?:-compose)?\s+(?:compose\s+)?up\b/i,
  // File & log watchers
  /\b(?:watch\s+|tail\s+-f|nodemon)\b/i,
  // Explicit background / nohup
  /(?:^|\s)nohup\s+/i,
  /&\s*$/,
  // Interactive wizards & shells
  /\b(?:ssh|telnet|mysql|psql|mongosh|redis-cli)\b/i,
  // Long running builds
  /\b(?:cargo\s+run|cargo\s+watch)\b/i
];

/**
 * Checks whether a tool call should be wrapped as a background command.
 */
export function shouldWrapCommand(fnName, argsObj = {}) {
  if (!fnName || !SHELL_TOOL_NAMES.has(fnName.toLowerCase())) {
    return false;
  }

  // 1. Explicit background flag in arguments
  if (argsObj.background === true || argsObj.is_background === true) {
    return true;
  }

  // 2. Command matching long-running or interactive patterns
  const cmd = (argsObj.command || argsObj.cmd || argsObj.input || "").trim();
  if (!cmd) return false;

  return LONG_RUNNING_PATTERNS.some((pattern) => pattern.test(cmd));
}

/**
 * Wraps a raw shell command into a tmux-aware, PID-recording, log-preserving background executor.
 */
export function wrapLinuxBackgroundCommand(rawCmd) {
  if (!rawCmd || typeof rawCmd !== "string") return rawCmd;

  let cleaned = rawCmd.trim();
  // Strip trailing & if already present to prevent syntax conflicts
  cleaned = cleaned.replace(/&\s*$/, "").trim();

  // Escape double quotes and backslashes for bash sub-string
  const escapedCmd = cleaned.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$");

  return [
    'TASK_ID="zl_$(date +%s)_$RANDOM";',
    'LOG_FILE="/tmp/${TASK_ID}.log";',
    'EXIT_FILE="/tmp/${TASK_ID}.exit";',
    'if command -v tmux >/dev/null 2>&1; then',
    `tmux new-session -d -s "$TASK_ID" "(${escapedCmd}) > \\"$LOG_FILE\\" 2>&1; echo \\$? > \\"$EXIT_FILE\\"";`,
    'PID=$(tmux list-panes -t "$TASK_ID" -F "#{pane_pid}");',
    'echo "{\\"status\\":\\"running\\",\\"mode\\":\\"tmux\\",\\"session\\":\\"$TASK_ID\\",\\"pid\\":$PID,\\"log\\":\\"$LOG_FILE\\"}";',
    'else',
    `( (${cleaned}) > "$LOG_FILE" 2>&1; echo $? > "$EXIT_FILE" ) & PID=$!;`,
    'echo "{\\"status\\":\\"running\\",\\"mode\\":\\"subshell\\",\\"pid\\":$PID,\\"log\\":\\"$LOG_FILE\\"}";',
    'fi'
  ].join(" ");
}

/**
 * Intercepts tool calls array and injects the background wrapper for qualifying shell commands.
 */
export function enrichToolCallsWithWrapper(calls) {
  if (!Array.isArray(calls) || calls.length === 0) return calls;

  return calls.map((call) => {
    if (!call || !call.function || !call.function.name) return call;

    const fnName = call.function.name;
    let argsObj;
    try {
      argsObj = typeof call.function.arguments === "string"
        ? JSON.parse(call.function.arguments)
        : call.function.arguments;
    } catch (_) {
      return call;
    }

    if (shouldWrapCommand(fnName, argsObj)) {
      const targetKey = argsObj.command !== undefined ? "command"
                      : argsObj.cmd !== undefined ? "cmd"
                      : "input";
      const rawCmd = argsObj[targetKey];
      if (rawCmd && typeof rawCmd === "string") {
        const wrapped = wrapLinuxBackgroundCommand(rawCmd);
        const updatedArgs = {
          ...argsObj,
          [targetKey]: wrapped,
          _wrapped_background: true
        };
        return {
          ...call,
          function: {
            ...call.function,
            arguments: JSON.stringify(updatedArgs)
          }
        };
      }
    }

    return call;
  });
}
