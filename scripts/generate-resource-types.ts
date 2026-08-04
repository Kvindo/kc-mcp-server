#!/usr/bin/env node
/**
 * Fetches the Kvindo Cloud OpenAPI spec and regenerates src/resource-types.generated.ts —
 * the checked-in enum + per-type JSON Schemas that back list_resource_types /
 * describe_resource_type / create_or_update_resource's client-side validation.
 *
 * Usage:
 *   tsx scripts/generate-resource-types.ts            # regenerate src/resource-types.generated.ts
 *   tsx scripts/generate-resource-types.ts --check     # exit 1 if the checked-in file is stale (CI drift check)
 *
 * Source spec: KVINDO_SWAGGER_URL env var, defaults to the dev environment (matches the
 * existing kc-sdk-python drift-check convention — dev is reachable without a prod token in CI).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, "..", "src", "resource-types.generated.ts");
const SWAGGER_URL =
  process.env.KVINDO_SWAGGER_URL ?? "https://dev-cloud-api.avant-it.ru/swagger/v1/swagger.json";

const TOP_LEVEL_PATH_RE = /^\/api\/v1\/([a-z][a-z0-9-]*)$/;

interface OpenApiDoc {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
}

interface ResourceTypeInfo {
  id: string;
  kind: string;
  tag: string;
  schemaName: string;
  description: string;
  removed?: { since: string };
}

async function fetchSpec(): Promise<OpenApiDoc> {
  const res = await fetch(SWAGGER_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${SWAGGER_URL}: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as OpenApiDoc;
}

/** A type is only treated as a first-class resource if it exposes the full uniform 5-verb contract. */
function discoverResourceTypes(spec: OpenApiDoc): ResourceTypeInfo[] {
  const { paths } = spec;
  const found: ResourceTypeInfo[] = [];

  for (const [p, methods] of Object.entries(paths)) {
    const match = TOP_LEVEL_PATH_RE.exec(p);
    if (!match || !methods.put) continue;
    const id = match[1];
    if (!id) continue;

    const hasByIdGetDelete =
      !!paths[`${p}/{id}`]?.get && !!paths[`${p}/{id}`]?.delete;
    const hasList = !!paths[`${p}/get-by-labels`]?.get;
    const hasRequestPoll = !!paths[`${p}/request/{requestId}`]?.get;
    if (!hasByIdGetDelete || !hasList || !hasRequestPoll) {
      // Not a uniform CRUD resource (e.g. internal/support endpoints) — skip silently.
      continue;
    }

    const ref: string | undefined = methods.put.requestBody?.content?.["application/json"]?.schema?.$ref;
    const schemaName = ref?.replace("#/components/schemas/", "");
    if (!schemaName) continue;

    const tag: string = methods.put.tags?.[0] ?? id;
    const kind = schemaName.replace(/Resource$/, "");

    found.push({
      id,
      kind,
      tag: tag.replace(/Api$/, ""),
      schemaName,
      description: `Kvindo Cloud ${kind} resource`,
    });
  }

  return found.sort((a, b) => a.id.localeCompare(b.id));
}

/** BFS over $ref to collect only the schemas reachable from a resource type's own request schema. */
function collectSchemaClosure(
  rootSchemaName: string,
  allSchemas: Record<string, any>
): Record<string, any> {
  const closure: Record<string, any> = {};
  const queue = [rootSchemaName];
  while (queue.length > 0) {
    const name = queue.shift();
    if (!name || name in closure) continue;
    const schema = allSchemas[name];
    if (!schema) continue;
    closure[name] = schema;
    for (const ref of findRefs(schema)) {
      const refName = ref.replace("#/components/schemas/", "");
      if (!(refName in closure)) queue.push(refName);
    }
  }
  return closure;
}

function findRefs(node: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) findRefs(item, out);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "$ref" && typeof v === "string") out.add(v);
      else findRefs(v, out);
    }
  }
  return out;
}

/** Rewrite `#/components/schemas/X` refs to `#/definitions/X` so each type's schema is self-contained. */
function rewriteRefs(schema: unknown): unknown {
  const str = JSON.stringify(schema).replaceAll("#/components/schemas/", "#/definitions/");
  return JSON.parse(str);
}

/** OpenAPI 3.0's `nullable: true` isn't a JSON Schema keyword ajv understands — without this,
 * ajv (draft-07 semantics) would reject a legitimate `null` value for every nullable field, which
 * is nearly all of them here. Converts `{type: "X", nullable: true}` to `{type: ["X", "null"]}`. */
function convertNullable(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(convertNullable);
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = convertNullable(v);
    if (out.nullable === true && typeof out.type === "string") {
      out.type = [out.type, "null"];
    }
    delete out.nullable;
    return out;
  }
  return node;
}

function loadPreviousTypes(): Record<string, ResourceTypeInfo> {
  if (!existsSync(OUTPUT_PATH)) return {};
  const src = readFileSync(OUTPUT_PATH, "utf-8");
  const match = /export const RESOURCE_TYPE_INFO: Record<string, ResourceTypeInfo> = (\{[\s\S]*?\n\});/.exec(src);
  if (!match?.[1]) return {};
  try {
    // The generated object literal is valid JS once quoted keys are normalized — safe here
    // because we always generate it ourselves, in that exact shape, in the same script.
    return new Function(`return ${match[1]}`)();
  } catch {
    return {};
  }
}

function render(
  discovered: ResourceTypeInfo[],
  allSchemas: Record<string, any>,
  previous: Record<string, ResourceTypeInfo>
): string {
  const discoveredIds = new Set(discovered.map((d) => d.id));
  const removedCarryOver: ResourceTypeInfo[] = Object.values(previous)
    .filter((p) => !discoveredIds.has(p.id))
    .map((p) => ({ ...p, removed: p.removed ?? { since: new Date().toISOString().slice(0, 10) } }));

  const all = [...discovered, ...removedCarryOver].sort((a, b) => a.id.localeCompare(b.id));

  const infoEntries = all
    .map((t) => `  ${JSON.stringify(t.id)}: ${JSON.stringify(t, null, 2).split("\n").join("\n  ")}`)
    .join(",\n");

  const schemaEntries = discovered
    .map((t) => {
      const closure = collectSchemaClosure(t.schemaName, allSchemas);
      const rewritten = convertNullable(rewriteRefs(closure));
      const schema = {
        $id: `https://kc-mcp-server/resource-types/${t.id}.json`,
        $ref: `#/definitions/${t.schemaName}`,
        definitions: rewritten,
      };
      return `  ${JSON.stringify(t.id)}: ${JSON.stringify(schema)}`;
    })
    .join(",\n");

  return `// GENERATED FILE — do not edit by hand.
// Regenerate with \`npm run generate\` (fetches ${SWAGGER_URL}).
// See scripts/generate-resource-types.ts.

export interface ResourceTypeInfo {
  id: string;
  kind: string;
  tag: string;
  schemaName: string;
  description: string;
  removed?: { since: string };
}

export const RESOURCE_TYPE_INFO: Record<string, ResourceTypeInfo> = {
${infoEntries}
};

export const RESOURCE_TYPES: readonly string[] = Object.keys(RESOURCE_TYPE_INFO);

/** Per-type JSON Schema (self-contained, refs rewritten to a local "definitions" bag). Absent for removed types. */
export const RESOURCE_SCHEMAS: Record<string, object> = {
${schemaEntries}
};
`;
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  const spec = await fetchSpec();
  const discovered = discoverResourceTypes(spec);
  if (discovered.length === 0) {
    throw new Error("Discovered zero resource types — spec shape may have changed, refusing to write an empty file.");
  }

  if (checkOnly) {
    const previous = loadPreviousTypes();
    const previousIds = new Set(Object.values(previous).filter((p) => !p.removed).map((p) => p.id));
    const discoveredIds = new Set(discovered.map((d) => d.id));
    const added = [...discoveredIds].filter((id) => !previousIds.has(id));
    const removed = [...previousIds].filter((id) => !discoveredIds.has(id));
    if (added.length > 0 || removed.length > 0) {
      console.log(`Resource type drift detected against ${SWAGGER_URL}:`);
      if (added.length) console.log(`  + added:   ${added.join(", ")}`);
      if (removed.length) console.log(`  - removed: ${removed.join(", ")}`);
      process.exit(1);
    }
    console.log("No drift — checked-in resource-types.generated.ts is up to date.");
    return;
  }

  const previous = loadPreviousTypes();
  const output = render(discovered, spec.components.schemas, previous);
  writeFileSync(OUTPUT_PATH, output, "utf-8");
  console.log(`Wrote ${OUTPUT_PATH} — ${discovered.length} resource types.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
