/**
 * BP-Builder compatibility checks (Compatibility Check Manual v1.0,
 * Semantic Check Manual v1.0). Pure functions; see run.ts for the entry point.
 */
export { runChecks, overallVerdict, MAX_CANDIDATES } from "./run.ts";
export { runCheck1, normaliseFormats, commonFormats } from "./check1-format.ts";
export { runAuth } from "./check2-auth.ts";
export { runSchemaAvailability, selectSourceSchema } from "./check2-schema.ts";
export { runSemantics, applicableRows, annotations, tokenise } from "./check2-semantics.ts";
export { runTypes } from "./check2-types.ts";
export { runRequired, requiredKind } from "./check2-required.ts";
export { schemaFields, parameterFields, fieldMap, normaliseName, parentOf, BODY_FIELD } from "./fields.ts";
export { normaliseType, conversionOf, unitOf, registryRows } from "./data.ts";
export type * from "./types.ts";
export { runStandard, resolveStandard, relationOf } from "./check2-standard.ts";
