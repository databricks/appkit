import { spawn } from "node:child_process";
import { createLogger } from "../../../logging/logger";
import { whichBinary } from "./detect";
import type { InspectorAgentMessage, InspectorAgentProvider } from "./types";

const logger = createLogger("inspector:cursor");

export function createCursorProvider(): InspectorAgentProvider {
  const binaryPath = whichBinary("cursor-agent") || whichBinary("agent") || whichBinary("cursor");
  logger.info("Cursor CLI detection: %s", binaryPath || "not found");

  let lastSessionId: string | null = null;

  return {
    id: "cursor",
    label: "Cursor",
    mode: binaryPath ? "spawn" : "stored",
    available: true,

    async *run(
      prompt: string,
      cwd: string,
      signal: AbortSignal,
    ): AsyncGenerator<InspectorAgentMessage> {
      if (!binaryPath) {
        yield { type: "error", content: "Cursor CLI not found. Install from cursor.com/download" };
        yield { type: "done", content: "" };
        return;
      }

      const args = [
        "agent",
        "--print",
        "--output-format", "stream-json",
        "--trust",
        "--workspace", cwd,
      ];

      if (lastSessionId) {
        args.push("--resume", lastSessionId);
      } else {
        args.push("--continue");
      }

      args.push(prompt);

      const env = { ...process.env };
      delete env.NODE_OPTIONS;
      delete env.VSCODE_INSPECTOR_OPTIONS;
      delete env.NODE_DEV;

      logger.info("=== Cursor spawn start ===");
      logger.info("Binary: %s", binaryPath);
      logger.info("CWD: %s", cwd);
      logger.info("Session: %s", lastSessionId || "new");
      logger.info("Prompt (%d chars): %s", prompt.length, prompt.slice(0, 150));

      yield { type: "status", content: "Starting Cursor agent…" };

      const child = spawn(binaryPath, args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env,
      });

      child.stdin.end();

      logger.info("Spawned pid: %s", child.pid);

      const cleanup = () => {
        if (!child.killed) {
          logger.info("Killing cursor-agent pid %s", child.pid);
          child.kill("SIGTERM");
        }
      };
      signal.addEventListener("abort", cleanup, { once: true });

      const messages: InspectorAgentMessage[] = [];
      let notifyReady: (() => void) | null = null;
      let processExited = false;

      const push = (msg: InspectorAgentMessage) => {
        messages.push(msg);
        notifyReady?.();
      };

      let stderrChunks: string[] = [];
      let buffer = "";
      let eventCount = 0;

      child.stdout.on("data", (chunk) => {
        const raw = chunk.toString();
        logger.info("STDOUT (%d bytes): %s", raw.length, raw.slice(0, 500));
        buffer += raw;

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            eventCount++;
            logger.info("EVENT #%d type=%s", eventCount, event.type);

            if (event.type === "system" && typeof event.session_id === "string") {
              lastSessionId = event.session_id;
              logger.info("Captured session_id: %s", lastSessionId);
            }

            const text = extractText(event);
            if (text) {
              push({ type: "status", content: text });
            }
            if (event.type === "result") {
              push({ type: "status", content: "Completed" });
            }
          } catch {
            logger.warn("JSON parse failed: %s", line.slice(0, 200));
          }
        }
      });

      child.stdout.on("end", () => {
        logger.info("STDOUT end (events=%d)", eventCount);
      });

      child.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        stderrChunks.push(text);
        logger.warn("STDERR: %s", text.trim());
      });

      child.stderr.on("end", () => {
        logger.info("STDERR end");
      });

      child.on("error", (err) => {
        logger.error("SPAWN ERROR: %O", err);
        push({ type: "error", content: err.message });
        processExited = true;
        notifyReady?.();
      });

      child.on("close", (code, sig) => {
        logger.info("=== Cursor exited: code=%s signal=%s events=%d ===", code, sig, eventCount);
        const stderr = stderrChunks.join("");
        if (stderr.trim()) {
          logger.warn("Full stderr:\n%s", stderr.trim());
          if (eventCount === 0) {
            push({ type: "error", content: "cursor-agent exited with no output. stderr: " + stderr.trim().slice(0, 300) });
          }
        }
        if (eventCount === 0 && !stderr.trim()) {
          push({ type: "error", content: "cursor-agent exited immediately with code " + code + " and no output" });
        }
        processExited = true;
        notifyReady?.();
      });

      try {
        while (!processExited && !signal.aborted) {
          if (messages.length > 0) {
            yield messages.shift()!;
          } else {
            await new Promise<void>((r) => { notifyReady = r; });
            notifyReady = null;
          }
        }

        while (messages.length > 0) {
          yield messages.shift()!;
        }

        if (!signal.aborted) {
          yield { type: "done", content: "" };
        }

        logger.info("=== Cursor provider done ===");
      } finally {
        signal.removeEventListener("abort", cleanup);
        cleanup();
      }
    },
  };
}

function extractText(event: Record<string, unknown>): string {
  if (
    event.type === "assistant" &&
    event.message &&
    typeof event.message === "object"
  ) {
    const msg = event.message as Record<string, unknown>;
    if (Array.isArray(msg.content)) {
      return (msg.content as Array<{ type: string; text?: string }>)
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text!)
        .join(" ");
    }
  }

  if (event.type === "result" && typeof event.result === "string") {
    return event.result;
  }

  if (typeof event.content === "string" && event.content) {
    return event.content;
  }

  if (typeof event.text === "string" && event.text) {
    return event.text;
  }

  return "";
}
