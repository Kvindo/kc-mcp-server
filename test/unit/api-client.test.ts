import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiClient, KvindoApiError } from "../../src/api-client.js";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("ApiClient.redact", () => {
  it("strips the configured token from any string", () => {
    const client = new ApiClient("https://api.example", "s3cr3t-token");
    const text = `error calling API: Authorization: Bearer s3cr3t-token failed`;
    expect(client.redact(text)).not.toContain("s3cr3t-token");
    expect(client.redact(text)).toContain("[REDACTED]");
  });
});

describe("ApiClient requests", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns resources and the next cursor from get-by-labels", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { resources: [{ metadata: { id: "1" } }], pagination: { enumeratorId: "cursor-2" } })
    );
    const client = new ApiClient("https://api.example", "tok");
    const result = await client.listResources("vm", undefined, undefined, 10);
    expect(result.resources).toHaveLength(1);
    expect(result.nextEnumeratorId).toBe("cursor-2");
  });

  it("treats an embedded errorCode on a 200 response as a logical error (e.g. NotFound)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { errorCode: "NotFound", errorMessage: null, resource: null }));
    const client = new ApiClient("https://api.example", "tok");
    await expect(client.getResource("vm", "missing-id")).rejects.toMatchObject({
      errorCode: "NotFound",
    } satisfies Partial<KvindoApiError>);
  });

  it("maps an Unauthorized errorCode to a clear permission message", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { errorCode: "Unauthorized", errorMessage: null }));
    const client = new ApiClient("https://api.example", "tok");
    await expect(client.getResource("vm", "x")).rejects.toThrow(/lacks permission|expired/);
  });

  it("retries a 5xx once and succeeds on the next attempt", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(500, {}))
      .mockResolvedValueOnce(jsonResponse(200, { resources: [], pagination: {} }));
    const client = new ApiClient("https://api.example", "tok");
    const result = await client.listResources("vm", undefined, undefined, 10);
    expect(result.resources).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("gives up after exhausting retries on a persistent 5xx", async () => {
    fetchMock.mockResolvedValue(jsonResponse(503, {}));
    const client = new ApiClient("https://api.example", "tok");
    await expect(client.listResources("vm", undefined, undefined, 10)).rejects.toThrow(KvindoApiError);
    // 1 initial + 3 retries
    expect(fetchMock).toHaveBeenCalledTimes(4);
  }, 15_000);

  it("fails immediately on a 429 whose Retry-After exceeds the wait cap, without retrying", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(429, {}, { "retry-after": "3600" }));
    const client = new ApiClient("https://api.example", "tok");
    await expect(client.listResources("vm", undefined, undefined, 10)).rejects.toMatchObject({
      errorCode: "RateLimited",
    } satisfies Partial<KvindoApiError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps 423 to a clear 'already being modified' message without retrying", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(423, {}));
    const client = new ApiClient("https://api.example", "tok");
    await expect(client.deleteResource("vm", "x")).rejects.toMatchObject({
      errorCode: "ResourceLocked",
    } satisfies Partial<KvindoApiError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a plain 4xx (bad manifest, etc.)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { errorCode: "BadData", errorMessage: "bad" }));
    const client = new ApiClient("https://api.example", "tok");
    await expect(client.createOrUpdateResource("vm", {})).rejects.toMatchObject({
      errorCode: "BadData",
    } satisfies Partial<KvindoApiError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
