import { z } from "zod";
import { Ajv, type ValidateFunction } from "ajv";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RESOURCE_TYPE_INFO, RESOURCE_TYPES, RESOURCE_SCHEMAS } from "../resource-types.generated.js";
import { textResult, withErrorHandling, type ToolContext } from "../server.js";
import { auditLog } from "../audit.js";

const typeEnum = () => z.enum(RESOURCE_TYPES as [string, ...string[]]);

// logger: false — the checked-in schema uses OpenAPI-only `format` values (date-time on plain
// strings, etc.) ajv doesn't validate without the ajv-formats plugin; that's fine for a
// convenience/shape-only check, but ajv's noisy "unknown format ... ignored" warnings on every
// compile aren't worth a dependency just to silence.
const ajv = new Ajv({ strict: false, allErrors: true, logger: false });
const validatorCache = new Map<string, ValidateFunction>();

function requireKnownWritableType(type: string): void {
  const info = RESOURCE_TYPE_INFO[type];
  if (!info) {
    throw new Error(`Unknown resource type "${type}". Call list_resource_types() for valid values.`);
  }
  if (info.removed || !RESOURCE_SCHEMAS[type]) {
    throw new Error(`Resource type "${type}" was removed from the API (since ${info.removed?.since}) and can no longer be written.`);
  }
}

function getValidator(type: string): ValidateFunction {
  let validator = validatorCache.get(type);
  if (!validator) {
    validator = ajv.compile(RESOURCE_SCHEMAS[type] as object);
    validatorCache.set(type, validator);
  }
  return validator;
}

/** Client-side shape check only — a convenience layer, not the authority. Any gap between this
 * checked-in schema and the live API surfaces as a normal API error same as before this existed. */
function validateManifestOrThrow(type: string, manifest: unknown): void {
  const validate = getValidator(type);
  if (!validate(manifest)) {
    const details = (validate.errors ?? [])
      .map((e) => `${e.instancePath || "(root)"}: ${e.message}`)
      .join("; ");
    throw new Error(`Manifest for "${type}" failed schema validation: ${details}`);
  }
}

export function registerWriteTools(server: McpServer, ctx: ToolContext): void {
  if (ctx.config.allowWrite) {
    server.registerTool(
      "create_or_update_resource",
      {
        title: "Create or update a Kvindo Cloud resource",
        description:
          "Creates a new resource, or updates an existing one if manifest.metadata.id is set — idempotent " +
          "on that id. Validates the manifest against the type's schema client-side before sending. This is " +
          "asynchronous: the response carries a requestId — poll get_request_status until `succeeded` is true " +
          "before assuming the resource is ready.",
        inputSchema: {
          type: typeEnum(),
          manifest: z.record(z.unknown()).describe("Full envelope: { metadata, spec } (apiVersion/kind/status are server-assigned)."),
        },
      },
      withErrorHandling(ctx, async ({ type, manifest }) => {
        requireKnownWritableType(type);
        validateManifestOrThrow(type, manifest);
        const result = await ctx.api.createOrUpdateResource(type, manifest);
        auditLog(ctx.api.redact.bind(ctx.api), "create_or_update_resource", type, `resourceId=${result.resourceId} requestId=${result.requestId}`);
        return textResult({
          ...result,
          note: "Write accepted but not yet applied — poll get_request_status({ type, requestId }) until succeeded.",
        });
      })
    );
  }

  if (ctx.config.allowDelete) {
    server.registerTool(
      "delete_resource",
      {
        title: "Delete a Kvindo Cloud resource",
        description:
          "Deletes a resource by id. Irreversible for most resource types. Requires confirm: true as an " +
          "explicit per-call safety gate on top of this tool only being available when KVINDO_MCP_ALLOW_DELETE " +
          "is set. Asynchronous — poll get_request_status until `succeeded` is true.",
        inputSchema: {
          type: typeEnum(),
          id: z.string(),
          confirm: z.boolean().describe("Must be true to proceed — a safety gate, not optional."),
        },
      },
      withErrorHandling(ctx, async ({ type, id, confirm }) => {
        requireKnownWritableType(type);
        if (!confirm) {
          throw new Error("Refusing to delete without confirm: true. Re-call with confirm: true if you intend to delete this resource.");
        }
        const result = await ctx.api.deleteResource(type, id);
        auditLog(ctx.api.redact.bind(ctx.api), "delete_resource", type, `id=${id} requestId=${result.requestId}`);
        return textResult({
          ...result,
          note: "Delete accepted but not yet applied — poll get_request_status({ type, requestId }) until succeeded.",
        });
      })
    );
  }
}
