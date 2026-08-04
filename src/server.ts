import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { ApiClient, KvindoApiError } from "./api-client.js";
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";

export interface ToolContext {
  api: ApiClient;
  config: Config;
}

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export function textResult(data: unknown): ToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

export function errorResult(ctx: ToolContext, err: unknown): ToolResult {
  const message =
    err instanceof KvindoApiError
      ? `${err.errorCode ?? `HTTP ${err.status}`}: ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
  return { content: [{ type: "text", text: ctx.api.redact(message) }], isError: true };
}

/** Wraps a tool handler so any thrown error (API error, validation error, unexpected bug)
 * becomes a normal MCP tool error result instead of crashing the server process. */
export function withErrorHandling<Args extends unknown[]>(
  ctx: ToolContext,
  fn: (...args: Args) => Promise<ToolResult>
): (...args: Args) => Promise<ToolResult> {
  return async (...args: Args) => {
    try {
      return await fn(...args);
    } catch (err) {
      return errorResult(ctx, err);
    }
  };
}

export function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "kc-mcp-server", version: "0.1.0" });
  registerReadTools(server, ctx);
  registerWriteTools(server, ctx);
  return server;
}
