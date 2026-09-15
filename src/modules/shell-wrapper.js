/**
 * ZeroLLM — Native Linux Shell Background Execution Wrapper
 * 
 * Automatically wraps long-running, daemon, or background shell tool commands:
 * - Pure, lightweight POSIX-compatible subshell backgrounding (no tmux dependency).
 * - Preserves all stdout & stderr in `/tmp/zl_*.log` (never discarded to /dev/null).
 * - Records PID ($!) and exit status code for reliable monitoring.
 * - Emits clean JSON metadata so the caller/agent knows PID and log path instantly.
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

  // 2. Command matching long-running or daemon patterns
  const cmd = (argsObj.command || argsObj.cmd || argsObj.input || "").trim();
  if (!cmd) return false;

  return LONG_RUNNING_PATTERNS.some((pattern) => pattern.test(cmd));
}

/**
 * Wraps a raw shell command into a clean, log-preserving, PID-recording background executor.
 */
export function wrapLinuxBackgroundCommand(rawCmd) {
  if (!rawCmd || typeof rawCmd !== "string") return rawCmd;

  let cleaned = rawCmd.trim();
  // Strip trailing & if already present to prevent syntax conflicts
  cleaned = cleaned.replace(/&\s*$/, "").trim();

  return [
    'TASK_ID="zl_$(date +%s)_$RANDOM";',
    'LOG_FILE="/tmp/${TASK_ID}.log";',
    'EXIT_FILE="/tmp/${TASK_ID}.exit";',
    `( (${cleaned}) > "$LOG_FILE" 2>&1; echo $? > "$EXIT_FILE" ) & PID=$!;`,
    'echo "{\\"status\\":\\"running\\",\\"pid\\":$PID,\\"log\\":\\"$LOG_FILE\\",\\"exit\\":\\"$EXIT_FILE\\"}";'
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
