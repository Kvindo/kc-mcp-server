import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWriteTools } from "../../src/tools/write.js";
import { ApiClient } from "../../src/api-client.js";
import type { ToolContext } from "../../src/server.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;

function fakeServer(): { handlers: Map<string, Handler>; server: McpServer } {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, cb: Handler) => {
      handlers.set(name, cb);
    },
  } as unknown as McpServer;
  return { handlers, server };
}

function jsonResponse(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("create_or_update_resource", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects a manifest that fails schema validation without calling the API", async () => {
    const { handlers, server } = fakeServer();
    const ctx: ToolContext = {
      api: new ApiClient("https://api.example", "tok"),
      config: { apiToken: "tok", apiUrl: "https://api.example", allowWrite: true, allowDelete: false },
    };
    registerWriteTools(server, ctx);

    const result = await handlers.get("create_or_update_resource")!({
      type: "ssh-key",
      manifest: { spec: { publicKey: 12345 } },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("failed schema validation");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a valid manifest and forwards it to the API", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { requestId: "req-1", resourceId: "res-1" }));
    const { handlers, server } = fakeServer();
    const ctx: ToolContext = {
      api: new ApiClient("https://api.example", "tok"),
      config: { apiToken: "tok", apiUrl: "https://api.example", allowWrite: true, allowDelete: false },
    };
    registerWriteTools(server, ctx);

    const result = await handlers.get("create_or_update_resource")!({
      type: "ssh-key",
      manifest: { metadata: { name: "x" }, spec: { publicKey: "ssh-ed25519 AAAA" } },
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("req-1");
  });

  it("rejects an unknown resource type before touching the network", async () => {
    const { handlers, server } = fakeServer();
    const ctx: ToolContext = {
      api: new ApiClient("https://api.example", "tok"),
      config: { apiToken: "tok", apiUrl: "https://api.example", allowWrite: true, allowDelete: false },
    };
    registerWriteTools(server, ctx);

    const result = await handlers.get("create_or_update_resource")!({
      type: "not-a-real-type",
      manifest: {},
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Unknown resource type");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("delete_resource", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuses to delete without confirm: true, without calling the API", async () => {
    const { handlers, server } = fakeServer();
    const ctx: ToolContext = {
      api: new ApiClient("https://api.example", "tok"),
      config: { apiToken: "tok", apiUrl: "https://api.example", allowWrite: false, allowDelete: true },
    };
    registerWriteTools(server, ctx);

    const result = await handlers.get("delete_resource")!({ type: "ssh-key", id: "x", confirm: false });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("confirm: true");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deletes when confirm: true is passed", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { requestId: "req-2", resourceId: "res-2" }));
    const { handlers, server } = fakeServer();
    const ctx: ToolContext = {
      api: new ApiClient("https://api.example", "tok"),
      config: { apiToken: "tok", apiUrl: "https://api.example", allowWrite: false, allowDelete: true },
    };
    registerWriteTools(server, ctx);

    const result = await handlers.get("delete_resource")!({ type: "ssh-key", id: "res-2", confirm: true });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("req-2");
  });
});
