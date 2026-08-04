import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerReadTools } from "../../src/tools/read.js";
import { registerWriteTools } from "../../src/tools/write.js";
import { ApiClient } from "../../src/api-client.js";
import type { ToolContext } from "../../src/server.js";

/** Records registered tool names without needing a real transport/protocol round trip —
 * registerTool() is the only McpServer method the tool modules call. */
function fakeServer(): { registered: string[]; server: McpServer } {
  const registered: string[] = [];
  const server = {
    registerTool: (name: string) => {
      registered.push(name);
    },
  } as unknown as McpServer;
  return { registered, server };
}

function ctx(allowWrite: boolean, allowDelete: boolean): ToolContext {
  return {
    api: new ApiClient("https://api.example", "tok"),
    config: { apiToken: "tok", apiUrl: "https://api.example", allowWrite, allowDelete },
  };
}

describe("tool registration gating", () => {
  it("always registers the 5 read-only tools", () => {
    const { registered, server } = fakeServer();
    registerReadTools(server, ctx(false, false));
    expect(registered).toEqual([
      "list_resource_types",
      "describe_resource_type",
      "list_resources",
      "get_resource",
      "get_request_status",
    ]);
  });

  it("registers no write tools when both gates are off", () => {
    const { registered, server } = fakeServer();
    registerWriteTools(server, ctx(false, false));
    expect(registered).toEqual([]);
  });

  it("registers only create_or_update_resource when write is on but delete is off", () => {
    const { registered, server } = fakeServer();
    registerWriteTools(server, ctx(true, false));
    expect(registered).toEqual(["create_or_update_resource"]);
  });

  it("registers only delete_resource when delete is on but write is off", () => {
    const { registered, server } = fakeServer();
    registerWriteTools(server, ctx(false, true));
    expect(registered).toEqual(["delete_resource"]);
  });

  it("registers both write tools when both gates are on", () => {
    const { registered, server } = fakeServer();
    registerWriteTools(server, ctx(true, true));
    expect(registered).toEqual(["create_or_update_resource", "delete_resource"]);
  });
});
