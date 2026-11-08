/**
 * Entry point: run Check 0 → Check 3 over one ordered pair and compute the
 * overall verdict (Compatibility Check Manual v1.0, chapters 4–9).
 *
 *   const report = runChecks({ source, target, formatAliases, choices });
 *
 * The page reads `report` (chapter 9). When `report.overall.overall` is
 * `pending_user`, the page shows the drop-downs for
 * `report.check2.semantics.ambiguous` / `.not_found` (required first) and
 * appends the answers to `check_choice` (append-only history). On every check
 * the pair's whole history is passed as `choices`; the engine merges it per
 * field: agreed answers apply at once, disagreeing answers (between users, or
 * between a user and the registry's automatic match) are held in
 * `conflicts` and the verdict becomes `pending_admin` until an administrator
 * answers (`kind = "admin"`, final). Answers given against a schema that has
 * since changed are dropped (`stale_choices`). Registry maintenance never
 * touches individual answers: it reads `v_registry_candidates` in batches.
 */
import { runCheck1 } from "./check1-format.ts";
import { runAuth } from "./check2-auth.ts";
import { runStandard } from "./check2-standard.ts";
import { runSchemaAvailability } from "./check2-schema.ts";
import { runSemantics } from "./check2-semantics.ts";
import { runTypes } from "./check2-types.ts";
import { requiredKind, runRequired } from "./check2-required.ts";
import { fieldMap } from "./fields.ts";
import type {  Check3Result, CheckReport, OverallResult, PairInput, ReasonCode, SemanticsResult, UserChoice, Verdict} from "./types.ts";
import { runCheck0 } from "./check0-operation.ts";
import { runCheck3, waitingCheck3 } from "./check3-constraints.ts";
import { declaredDocuments, findCarrier, passThrough, type DocumentCarrier } from "./documents.ts";
/** Chapter 9: at most 8 candidates per field, plus the two fixed options the page appends. */
export const MAX_CANDIDATES = 8;

function hasExplicitEmptyRequiredSet(raw: unknown): boolean {
  return (
    typeof raw === "object"
    && raw !== null
    && Object.prototype.hasOwnProperty.call(raw, "required")
    && Array.isArray((raw as { required?: unknown }).required)
    && (raw as { required: unknown[] }).required.length === 0
  );
}

function comparisonSide(
  side: PairInput["source"],
  schemaId: string | null | undefined,
): PairInput["source"] {
  if (!schemaId) return side;

  return {
    ...side,
    schemas: side.schemas.filter((schema) => schema.id === schemaId),
  };
}

export function runChecks(original: PairInput): CheckReport {
  const c0 = runCheck0(original);

  /*
   * Resolve validator pass-through from the complete source before applying
   * response selection. Otherwise the selected response removes the request
   * document needed by passThrough(). Ordinary sources still honour selection.
   */
  const passedSource = passThrough(original.source);
  const sourcePassedThrough = passedSource !== original.source;
  const input: PairInput = {
    ...original,
    source: sourcePassedThrough
      ? passedSource
      : comparisonSide(passedSource, original.selectedSourceSchemaId),
    target: comparisonSide(original.target, original.selectedTargetSchemaId),
  };

  const c1 = runCheck1(input);
  const auth = runAuth(input);
  // 2.0b reads a pass-through validator on its input side (#42).
  const standard = runStandard(
    input.source,
    input.target,
    sourcePassedThrough,
  );
  const inputInParameters = c1.flags.includes("input_in_parameters");
  // Check 1 settles which format the comparison is made in: the page's choice
  // when it made one, otherwise the default of §6.4. Everything downstream
  // reads the same value, so 2.1 cannot end up comparing a schema in a format
  // the page never offered.
  const pair: PairInput = { ...input, selectedFormat: c1.format_selected };
  const { result: schema, sourceFields, targetFields } = runSchemaAvailability(pair, inputInParameters);

  let semantics: CheckReport["check2"]["semantics"] = null;
  let types: CheckReport["check2"]["types"] = null;
  let required: CheckReport["check2"]["required"] = null;
  let check3: Check3Result = waitingCheck3();

  const sourceSchema = pair.source.schemas.find((s) => s.id === schema.source_schema_used?.schema_id) ?? null;
  const targetSchema = pair.target.schemas.find((s) => s.id === schema.target_schema_used?.schema_id) ?? null;
  // Both sides must carry an opaque document. An XML schema with fields is
  // not taken for one: XML is a syntax, and a query or status message written
  // in XML is not an invoice file (decided 12 October 2026).
  const sourceCarrier = sourceSchema ? findCarrier(sourceSchema, pair.source.api.category, declaredDocuments(pair.source, "output", pair.formatAliases)) : null;
  const targetCarrier = targetSchema ? findCarrier(targetSchema, pair.target.api.category, declaredDocuments(pair.target, "input", pair.formatAliases)) : null;

  if (schema.status === "pass" && sourceCarrier && targetCarrier) {
    // Both sides exchange a whole document (#41): the file is handed over as
    // it is, so there is no field matching, no type conversion and no value
    // constraint to judge. The target's other inputs are settings of the call.
    schema.flags.push("document_exchange");
    const doc = documentExchange(sourceCarrier, targetCarrier, targetFields);
    semantics = doc.semantics;
    types = doc.types;
    required = runRequired({
      targetFields,
      sourceFields: fieldMap(sourceFields),
      mappings: semantics.mappings,
      conversions: types.conversions,
      externalByChoice: [],
      uncoveredByChoice: [],
      excludedPaths: semantics.excluded.map((e) => e.path),
      requiredInformationConfirmed: true,
    });
    check3 = runCheck3({ mappings: semantics.mappings, sourceFields: fieldMap(sourceFields), targetFields: fieldMap(targetFields), conversions: types.conversions });
  } else if (schema.status === "pass") {
    const { live, stale } = splitStaleChoices(original, schema.source_schema_used?.schema_id ?? null, schema.target_schema_used?.schema_id ?? null);
    semantics = runSemantics({
      sourceVendor: input.source.api.company_name,
      targetVendor: input.target.api.company_name,
      sourceFields,
      targetFields,
      choices: live,
      staleChoices: stale,
    });
    for (const a of semantics.ambiguous) {
      a.candidates.sort((x, y) => x.source_path.length - y.source_path.length);
      a.candidates = a.candidates.slice(0, MAX_CANDIDATES);
    }
    const srcMap = fieldMap(sourceFields);
    const tgtMap = fieldMap(targetFields);
    const requiredPaths = new Set(targetFields.filter((f) => requiredKind(f, tgtMap) !== null).map((f) => f.path));
    // 2.3 runs on the mappings known so far (also while choices are pending, so the page can show them).
    types = runTypes(semantics.mappings, srcMap, tgtMap, requiredPaths);


      if (semantics.status === "complete") {
       required = runRequired({
         targetFields,
         sourceFields: srcMap,
         mappings: semantics.mappings,
         conversions: types.conversions,
         externalByChoice: semantics.external_by_choice,
         uncoveredByChoice: semantics.uncovered_by_choice,
         excludedPaths: semantics.excluded.map(
           (entry) => entry.path,
         ),
         requiredInformationConfirmed: hasExplicitEmptyRequiredSet(
           input.target.schemas.find((entry) => entry.direction === "request")?.raw,
         ),
       });

       check3 = runCheck3({
         mappings: semantics.mappings,
         sourceFields: srcMap,
         targetFields: tgtMap,
         conversions: types.conversions,
        });
      } else {
        check3 = waitingCheck3(
          semantics.mappings,
          types.conversions,
       );
      }
  }

  const report: CheckReport = {
    source: { id: input.source.api.id, name: input.source.api.api_name },
    target: { id: input.target.api.id, name: input.target.api.api_name },
    check0: c0,
    check1: c1,
    check2: { auth, standard, schema, semantics, types, required },
    check3,
    overall: { overall: "fail", blocking_checks: [], blocking_reason: null, reason_codes: [] },
  };
  report.overall = overallVerdict(report);
  return report;
}

/** The single mapping of a whole-document exchange (#41). */
function documentExchange(source: DocumentCarrier, target: DocumentCarrier, targetFields: readonly { path: string }[]) {
  const notes = ["whole_document"];
  const conditions: string[] = [];
  if (source.kind === "base64" && target.kind !== "base64") notes.push("decode_base64");
  if (source.kind === "byte-array" && target.kind !== "byte-array") notes.push("decode_byte_array");
  if (target.kind === "base64" && source.kind !== "base64") notes.push("encode_base64");
  if (target.kind === "byte-array" && source.kind !== "byte-array") notes.push("encode_byte_array");
  if (notes.includes("decode_base64")) conditions.push("the document is decoded from base64");
  if (notes.includes("decode_byte_array")) conditions.push("the document is reconstructed from a JSON byte array");
  if (notes.includes("encode_base64")) conditions.push("the document is sent base64-encoded");
  if (notes.includes("encode_byte_array")) conditions.push("the document is sent as a JSON array of byte values (0–255)");
  const condition = conditions.length ? conditions.join(" and ") : "the document is passed on unchanged";
  const semantics: NonNullable<CheckReport["check2"]["semantics"]> = {
    status: "complete",
    mappings: [{ target_path: target.path, source_path: source.path, unit_id: "document", origin: "auto", notes }],
    ambiguous: [],
    not_found: [],
    excluded: targetFields.filter((f) => f.path !== target.path).map((f) => ({ path: f.path, reason: "envelope" as const })),
    uncovered_by_choice: [],
    external_by_choice: [],
    stale_choices: [],
    applied: [],
    conflicts: [],
  };
  const types: NonNullable<CheckReport["check2"]["types"]> = {
    status: "pass",
    reason_code: null,
    conversions: [{ target_path: target.path, source_path: source.path, source_type: "document", target_type: "document", kind: "same", condition }],
    flags: [],
  };
  return { semantics, types };
}

/**
 * A saved choice is applied only while the schemas it was given against are
 * the ones compared now (Semantic Check Manual §4). A choice that carries no
 * hash is applied as is.
 */
/**
 * An answer applies only to the schemas it was given against. Two things can
 * break that: the stored schema really changed, or the pair is now being
 * compared in another format, whose schema is a different row with a different
 * hash. Both make the answer inapplicable, and the second is not a defect, so
 * the two are reported apart and the page words them differently.
 */
function splitStaleChoices(input: PairInput, sourceSchemaId: string | null, targetSchemaId: string | null) {
  const sourceHash = input.source.schemas.find((s) => s.id === sourceSchemaId)?.content_hash ?? null;
  const targetHash = input.target.schemas.find((s) => s.id === targetSchemaId)?.content_hash
    ?? input.target.schemas.find((s) => s.direction === "request")?.content_hash
    ?? null;
  // Hashes of the same pair's other stored schemas: an answer carrying one of
  // these was given in another format, not against a schema that has changed.
  const otherFormatHashes = new Set(
    [...input.source.schemas, ...input.target.schemas]
      .filter((s) => s.id !== sourceSchemaId && s.id !== targetSchemaId)
      .map((s) => s.content_hash)
      .filter((hash): hash is string => typeof hash === "string" && hash !== ""),
  );
  const live: UserChoice[] = [];
  const stale: SemanticsResult["stale_choices"] = [];
  const reasonFor = (hash: string, fallback: "source_schema_changed" | "target_schema_changed") =>
    otherFormatHashes.has(hash) ? "format_changed" as const : fallback;
  for (const c of input.choices ?? []) {
    if (c.source_content_hash && sourceHash && c.source_content_hash !== sourceHash) {
      stale.push({ target_path: c.target_path, reason: reasonFor(c.source_content_hash, "source_schema_changed") });
    } else if (c.target_content_hash && targetHash && c.target_content_hash !== targetHash) {
      stale.push({ target_path: c.target_path, reason: reasonFor(c.target_content_hash, "target_schema_changed") });
    } else {
      live.push(c);
    }
  }
  return { live, stale };
}

/** §4.2: all must pass; undetermined counts as fail; non-voting is ignored; pending choices stop the verdict. */
/**
 * All voting checks must pass.
 *
 * - fail means the pair is incompatible;
 * - unknown means there is insufficient information;
 * - not_voting is ignored;
 * - unresolved required mappings produce pending_user or pending_admin.
 */
export function overallVerdict(
  report: CheckReport,
): OverallResult {
  /*
   * Only Check 1, Check 2.0b and Check 2.1 decide whether asking the user
   * about field mappings is meaningful. A format, invoice-standard or
   * schema-availability problem cannot be repaired by selecting a different
   * field (2.0b: decided 7 October 2026, issue #42).
   *
   * Check 0 does not belong in this early-blocking list. Even if the
   * operation order is invalid, displaying field mappings is still useful.
   */
  const beforeSemantics: Array<
    [string, Verdict, ReasonCode | null]
  > = [
    [
      "check1",
      report.check1.status,
      report.check1.reason_code,
    ],
    [
      "check2.0b",
      report.check2.standard?.status ?? "not_voting",
      report.check2.standard?.reason_code ?? null,
    ],
    [
      "check2.1",
      report.check2.schema.status,
      report.check2.schema.reason_code,
    ],
  ];

  const blockedBeforeSemantics =
    beforeSemantics.some(
      ([, verdict]) =>
        verdict === "fail" ||
        verdict === "unknown",
    );

  if (
    !blockedBeforeSemantics &&
    (report.check2.semantics?.status ===
      "pending_user" ||
      report.check2.semantics?.status ===
        "pending_admin")
  ) {
    return {
      overall: report.check2.semantics.status,
      blocking_checks: ["check2.2"],
      blocking_reason: null,
      reason_codes: [],
    };
  }

  const votes: Array<
    [string, Verdict, ReasonCode | null]
  > = [
    [
      "check0",
      report.check0.status,
      report.check0.reason_code,
    ],
    [
      "check1",
      report.check1.status,
      report.check1.reason_code,
    ],
    [
      "check2.0a",
      report.check2.auth.status,
      null,
    ],
    [
      "check2.0b",
      report.check2.standard?.status ?? "not_voting",
      report.check2.standard?.reason_code ?? null,
    ],
    [
      "check2.1",
      report.check2.schema.status,
      report.check2.schema.reason_code,
    ],
  ];

  if (report.check2.types) {
    votes.push([
      "check2.3",
      report.check2.types.status,
      report.check2.types.reason_code,
    ]);
  }

  if (report.check2.required) {
    votes.push([
      "check2.4",
      report.check2.required.status,
      report.check2.required.reason_code,
    ]);
  }

  votes.push([
    "check3",
    report.check3.status,
    report.check3.reason_code,
  ]);

  const blocking = votes.filter(
    ([, verdict]) =>
      verdict === "fail" ||
      verdict === "unknown",
  );

  if (blocking.length === 0) {
    return {
      overall: "pass",
      blocking_checks: [],
      blocking_reason: null,
      reason_codes: [],
    };
  }

  const containsFailure = blocking.some(
    ([, verdict]) => verdict === "fail",
  );

  return {
    overall: "fail",
    blocking_checks: blocking.map(
      ([checkName]) => checkName,
    ),
    blocking_reason: containsFailure
      ? "incompatible"
      : "insufficient_info",
    reason_codes: [
      ...new Set(
        blocking
          .map(([, , reasonCode]) => reasonCode)
          .filter(
            (
              reasonCode,
            ): reasonCode is ReasonCode =>
              reasonCode !== null,
          ),
      ),
    ],
  };
}
