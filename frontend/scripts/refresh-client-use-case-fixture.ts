// Refresh tests/composition/fixtures/client-use-case-catalogue.json from the
// live site's public reads. No keys are needed and nothing is written to the
// database. format_alias is not public, so it is rebuilt from the migrations.
//
//   node scripts/refresh-client-use-case-fixture.ts [site URL]
//
// Then run the regression tests and read the diff: a change in the snapshot
// should be a record that was corrected on purpose.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { schemaContentHash } from "../lib/schema/extract.ts";

const SITE = process.argv[2] ?? "https://cs-47e1208ec06d46068a1db07170ff2d0a.ecs.ap-southeast-2.on.aws";
const frontend = fileURLToPath(new URL("../", import.meta.url));
const migrations = path.join(frontend, "../migrations");
const out = path.join(frontend, "tests/composition/fixtures/client-use-case-catalogue.json");

// The client's designated APIs whose schemas the tests need.
const SCHEMA_APIS = [
  "Upbrains Extract Invoice From PDF API",
  "EzzyBills Upload Invoice Image API",
  "Nanonets OCR Extract From File API",
  "AmitTransform Convert UBL JSON to UBL XML API",
  "ESS SmartDocFlow Validate PINT A-NZ Invoice API",
  "Mailgun Send Message API",
  "B2Brouter Import Invoice API",
];
// The columns the composition route reads (lib/composition/catalogue.ts).
const API_COLUMNS = ["id", "api_name", "official_api_name", "description", "instructions", "company_name",
  "country_region", "category", "network", "communication_direction", "is_active", "duplicate_of",
  "input_formats", "output_formats", "invoice_standard", "business_rules",
  "api_endpoint", "http_method", "authentication_method", "authentication_details"];

type Row = Record<string, unknown>;

/** Every `insert into public.format_alias ... on conflict (alias) do nothing`, in migration order. */
function formatAliases(): Row[] {
  const aliases = new Map<string, string>();
  for (const file of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
    const sql = readFileSync(path.join(migrations, file), "utf8");
    const pattern = /insert into public\.format_alias\s*\(([^)]*)\)\s*values([\s\S]*?)on conflict \(alias\) do nothing;/gi;
    for (const match of sql.matchAll(pattern)) {
      const columns = match[1].split(",").map((column) => column.trim());
      for (const tuple of literalTuples(match[2])) {
        const row = Object.fromEntries(columns.map((column, index) => [column, tuple[index]]));
        if (!aliases.has(row.alias)) aliases.set(row.alias, row.canonical);
      }
    }
  }
  return [...aliases].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([alias, canonical]) => ({ alias, canonical }));
}

/** The string literals of each `( ... )` tuple; comments and other tokens are skipped. */
function literalTuples(values: string): string[][] {
  const tuples: string[][] = [];
  let current: string[] | null = null;
  for (let i = 0; i < values.length; i += 1) {
    const char = values[i];
    if (char === "-" && values[i + 1] === "-") { i = values.indexOf("\n", i); if (i < 0) break; continue; }
    if (char === "(") current = [];
    else if (char === ")" && current) { tuples.push(current); current = null; }
    else if (char === "'" && current) {
      let text = "";
      for (i += 1; i < values.length; i += 1) {
        if (values[i] === "'" && values[i + 1] === "'") { text += "'"; i += 1; }
        else if (values[i] === "'") break;
        else text += values[i];
      }
      current.push(text);
    }
  }
  return tuples;
}

async function json(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

const catalogue = await json(`${SITE}/api/apis`) as { apis: Row[]; mode?: string };
if (catalogue.mode !== "supabase") throw new Error("The site did not answer from its database.");
const apis = catalogue.apis
  .filter((api) => api.is_active !== false && !api.duplicate_of)
  .map((api) => Object.fromEntries(API_COLUMNS.map((column) => [column, api[column] ?? null])))
  .sort((a, b) => String(a.id).localeCompare(String(b.id)));
const ids = SCHEMA_APIS.map((name) => {
  const api = apis.find((item) => item.api_name === name);
  if (!api) throw new Error(`${name} is not in the live catalogue.`);
  return String(api.id);
});

const api_schema: Row[] = [], api_schema_field: Row[] = [], api_parameter: Row[] = [];
const query = new URLSearchParams();
for (const id of [...ids].sort()) query.append("api_id", id);
const schemas = await json(`${SITE}/api/schemas?${query}`) as { apis: Array<{ api_id: string; schemas: Row[]; parameters: Row[] }> };
for (const api of schemas.apis) {
  for (const { fields, ...schema } of api.schemas as Array<Row & { fields: Row[] }>) {
    api_schema.push({
      id: schema.id, api_id: api.api_id, direction: schema.direction, status_code: schema.status_code,
      media_type: schema.media_type, raw: schema.raw,
      // The public read leaves out who verified a schema; only an informational flag uses it.
      verified_by: "", content_hash: schemaContentHash(schema.raw),
    });
    for (const field of fields) api_schema_field.push({ schema_id: schema.id, ...field });
  }
  for (const parameter of api.parameters) api_parameter.push({ api_id: api.api_id, ...parameter });
}

const tables: Record<string, Row[]> = {
  apis, api_schema, api_schema_field, api_parameter, format_alias: formatAliases(),
  api_invoice_standard_capability: [], check_choice: [],
};
const source = `Public reads of the live site (${SITE}) on ${new Date().toISOString().slice(0, 10)}; format_alias rebuilt from the migrations. `
  + `Schemas are kept only for the client's designated APIs used here: Upbrains, EzzyBills Upload Invoice Image, Nanonets, `
  + `AmitTransform Convert UBL JSON to UBL XML, ESS PINT A-NZ, Mailgun and B2Brouter. Other candidates have no schemas, so their chains show missing evidence.`;
// One row per line keeps the diff of a refresh readable.
const lines = [`{"source": ${JSON.stringify(source)},`, ` "tables": {`];
const names = Object.keys(tables);
names.forEach((name, index) => {
  const rows = tables[name];
  const body = rows.map((row) => `   ${JSON.stringify(row)}`).join(",\n");
  lines.push(`  "${name}": [${rows.length ? `\n${body}\n  ]` : "]"}${index < names.length - 1 ? "," : ""}`);
});
lines.push(" }\n}");
writeFileSync(out, `${lines.join("\n")}\n`);
console.log(Object.fromEntries(names.map((name) => [name, tables[name].length])));
