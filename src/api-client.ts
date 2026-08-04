const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;
const MAX_RETRY_AFTER_WAIT_MS = 10_000;

/** Structured error surfaced to tool handlers. `errorCode` mirrors the API's own typed error codes
 * (e.g. "NotFound", "Unauthorized", "ResourceIsScheduling") — see the Kvindo Cloud API docs. */
export class KvindoApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly errorCode: string | null,
    message: string
  ) {
    super(message);
    this.name = "KvindoApiError";
  }
}

export interface ModificationResult {
  requestId: string | null;
  resourceId: string | null;
}

export interface ListResult {
  resources: unknown[];
  nextEnumeratorId: string | null;
}

export interface RequestStatusResult {
  succeeded: boolean;
  scheduledResourceId: string | null;
}

interface EnvelopeBody {
  errorMessage?: string | null;
  errorCode?: string | null;
  [key: string]: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredBackoff(attempt: number): number {
  const base = BASE_BACKOFF_MS * 2 ** attempt;
  return base + Math.random() * base * 0.25;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly token: string;
  /** Exact literal to strip from any text before it's returned or logged — see redact(). */
  private readonly redactSecret: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
    this.redactSecret = token;
  }

  /** Removes the configured API token from any string before it leaves this process
   * (tool output or log line) — the one credential this server actually holds. */
  redact(text: string): string {
    return text.split(this.redactSecret).join("[REDACTED]");
  }

  async getResource(type: string, id: string): Promise<unknown | null> {
    const body = await this.request("GET", `/api/v1/${type}/${encodeURIComponent(id)}`);
    return (body as { resource?: unknown }).resource ?? null;
  }

  async listResources(
    type: string,
    labels: Record<string, string> | undefined,
    enumeratorId: string | undefined,
    maxPageSize: number
  ): Promise<ListResult> {
    const params = new URLSearchParams();
    if (labels) {
      for (const [k, v] of Object.entries(labels)) params.set(`labels[${k}]`, v);
    }
    if (enumeratorId) params.set("enumeratorId", enumeratorId);
    params.set("maxPageSize", String(maxPageSize));

    const body = (await this.request(
      "GET",
      `/api/v1/${type}/get-by-labels?${params.toString()}`
    )) as { resources?: unknown[]; pagination?: { enumeratorId?: string | null } };

    return {
      resources: body.resources ?? [],
      nextEnumeratorId: body.pagination?.enumeratorId ?? null,
    };
  }

  async createOrUpdateResource(type: string, manifest: unknown): Promise<ModificationResult> {
    const body = (await this.request("PUT", `/api/v1/${type}`, manifest)) as {
      requestId?: string | null;
      resourceId?: string | null;
    };
    return { requestId: body.requestId ?? null, resourceId: body.resourceId ?? null };
  }

  async deleteResource(type: string, id: string): Promise<ModificationResult> {
    const body = (await this.request("DELETE", `/api/v1/${type}/${encodeURIComponent(id)}`)) as {
      requestId?: string | null;
      resourceId?: string | null;
    };
    return { requestId: body.requestId ?? null, resourceId: body.resourceId ?? null };
  }

  async getRequestStatus(type: string, requestId: string): Promise<RequestStatusResult> {
    const body = (await this.request(
      "GET",
      `/api/v1/${type}/request/${encodeURIComponent(requestId)}`
    )) as { succeeded?: boolean; scheduledResourceId?: string | null };
    return {
      succeeded: body.succeeded ?? false,
      scheduledResourceId: body.scheduledResourceId ?? null,
    };
  }

  /** One authenticated round trip, with bounded retry on network errors / 5xx, and uniform
   * error-code handling: the API embeds `errorCode`/`errorMessage` in the response body even
   * on a 200 (e.g. a "NotFound" read), not just on 4xx/5xx — so every response is inspected
   * for that field regardless of HTTP status. */
  private async request(method: string, path: string, jsonBody?: unknown): Promise<EnvelopeBody> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            ...(jsonBody !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (res.status === 429) {
          const retryAfterSec = Number(res.headers.get("retry-after") ?? "");
          const waitMs = Number.isFinite(retryAfterSec) ? retryAfterSec * 1000 : BASE_BACKOFF_MS;
          if (attempt === 0 && waitMs <= MAX_RETRY_AFTER_WAIT_MS) {
            await sleep(waitMs);
            continue;
          }
          throw new KvindoApiError(429, "RateLimited", "Rate limited by the Kvindo Cloud API — retry later.");
        }

        if (res.status === 423) {
          throw new KvindoApiError(
            423,
            "ResourceLocked",
            "This resource is already being modified by another request — retry shortly."
          );
        }

        if (res.status >= 500) {
          if (attempt < MAX_RETRIES) {
            await sleep(jitteredBackoff(attempt));
            continue;
          }
          throw new KvindoApiError(res.status, null, `Kvindo Cloud API returned ${res.status} after ${MAX_RETRIES + 1} attempts.`);
        }

        const text = await res.text();
        let body: EnvelopeBody = {};
        if (text) {
          try {
            body = JSON.parse(text) as EnvelopeBody;
          } catch {
            throw new KvindoApiError(res.status, null, `Non-JSON response from Kvindo Cloud API (status ${res.status}).`);
          }
        }

        if (body.errorCode) {
          if (body.errorCode === "Unauthorized") {
            throw new KvindoApiError(
              res.status,
              "Unauthorized",
              "Token lacks permission for this operation (or has expired) — check console IAM → Tokens."
            );
          }
          throw new KvindoApiError(res.status, body.errorCode, body.errorMessage || `API error: ${body.errorCode}`);
        }

        if (!res.ok) {
          throw new KvindoApiError(res.status, null, `Kvindo Cloud API returned ${res.status}.`);
        }

        return body;
      } catch (err) {
        clearTimeout(timeout);
        if (err instanceof KvindoApiError) throw err;

        // Network error or timeout — retry with backoff, same budget as 5xx.
        lastError = err;
        if (attempt < MAX_RETRIES) {
          await sleep(jitteredBackoff(attempt));
          continue;
        }
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new KvindoApiError(0, null, `Network error calling Kvindo Cloud API after ${MAX_RETRIES + 1} attempts: ${message}`);
  }
}
