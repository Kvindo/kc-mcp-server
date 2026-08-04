import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RESOURCE_TYPE_INFO, RESOURCE_TYPES, RESOURCE_SCHEMAS } from "../resource-types.generated.js";
import { textResult, withErrorHandling, type ToolContext } from "../server.js";

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGES = 5;

const typeEnum = () => z.enum(RESOURCE_TYPES as [string, ...string[]]);

function requireKnownType(type: string): void {
  if (!(type in RESOURCE_TYPE_INFO)) {
    throw new Error(`Unknown resource type "${type}". Call list_resource_types() for valid values.`);
  }
}

export function registerReadTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_resource_types",
    {
      title: "List Kvindo Cloud resource types",
      description:
        "Lists every resource type this server can manage (VM, Volume, S3Bucket, Kubernetes, ...). " +
        "By default excludes types the backend has since removed. Call describe_resource_type(type) next " +
        "to get a type's manifest schema before creating/updating one.",
      inputSchema: {
        includeRemoved: z
          .boolean()
          .optional()
          .describe("Include resource types the backend no longer supports (default false)."),
      },
    },
    withErrorHandling(ctx, async ({ includeRemoved }) => {
      const types = Object.values(RESOURCE_TYPE_INFO).filter((t) => includeRemoved || !t.removed);
      return textResult(types);
    })
  );

  server.registerTool(
    "describe_resource_type",
    {
      title: "Describe a Kvindo Cloud resource type",
      description:
        "Returns the JSON Schema for a resource type's manifest (apiVersion/kind/metadata/spec/status envelope). " +
        "Use this before calling create_or_update_resource to construct a valid manifest.",
      inputSchema: { type: typeEnum() },
    },
    withErrorHandling(ctx, async ({ type }) => {
      requireKnownType(type);
      const info = RESOURCE_TYPE_INFO[type];
      const schema = RESOURCE_SCHEMAS[type];
      if (info?.removed || !schema) {
        throw new Error(`Resource type "${type}" was removed from the API (since ${info?.removed?.since}) and has no schema.`);
      }
      return textResult(schema);
    })
  );

  server.registerTool(
    "list_resources",
    {
      title: "List Kvindo Cloud resources",
      description:
        "Lists resources of a given type, optionally filtered by label. Auto-follows pagination up to " +
        `${MAX_PAGES} pages (max page size ${MAX_PAGE_SIZE}); if the result is truncated, narrow the label ` +
        "filter and call again rather than relying on unbounded pagination. There is no folderId filter at " +
        "the API level — filter by label if the resource carries a folder-identifying label.",
      inputSchema: {
        type: typeEnum(),
        labels: z.record(z.string()).optional().describe("Exact-match label filter, e.g. { env: \"prod\" }."),
        enumeratorId: z.string().optional().describe("Pagination cursor from a previous truncated response."),
        pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
        maxPages: z.number().int().min(1).max(MAX_PAGES).optional(),
      },
    },
    withErrorHandling(ctx, async ({ type, labels, enumeratorId, pageSize, maxPages }) => {
      requireKnownType(type);
      const size = Math.min(pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
      const pageCap = Math.min(maxPages ?? MAX_PAGES, MAX_PAGES);

      const resources: unknown[] = [];
      let cursor = enumeratorId;
      let pagesFetched = 0;

      for (; pagesFetched < pageCap; pagesFetched++) {
        const page = await ctx.api.listResources(type, labels, cursor, size);
        resources.push(...page.resources);
        cursor = page.nextEnumeratorId ?? undefined;
        if (!cursor) break;
      }

      const truncated = !!cursor;
      return textResult({
        resources,
        pagesFetched,
        nextEnumeratorId: cursor ?? null,
        truncated,
        ...(truncated
          ? { note: "Result truncated at the page cap. Narrow `labels` or pass `enumeratorId` to continue." }
          : {}),
      });
    })
  );

  server.registerTool(
    "get_resource",
    {
      title: "Get a Kvindo Cloud resource",
      description: "Fetches one resource of a given type by its ULID.",
      inputSchema: { type: typeEnum(), id: z.string() },
    },
    withErrorHandling(ctx, async ({ type, id }) => {
      requireKnownType(type);
      const resource = await ctx.api.getResource(type, id);
      return textResult(resource);
    })
  );

  server.registerTool(
    "get_request_status",
    {
      title: "Poll a Kvindo Cloud async request",
      description:
        "Polls the status of a change request returned by create_or_update_resource or delete_resource. " +
        "Writes are asynchronous — call this (with backoff) until `succeeded` is true rather than assuming " +
        "the write completed immediately.",
      inputSchema: { type: typeEnum(), requestId: z.string() },
    },
    withErrorHandling(ctx, async ({ type, requestId }) => {
      requireKnownType(type);
      const status = await ctx.api.getRequestStatus(type, requestId);
      return textResult(status);
    })
  );
}
