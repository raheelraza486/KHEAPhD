/**
 * Check item 2.2 · field-semantics check.
 *
 * Implements rules S-0 … S-8 of the Semantic Check Manual v1.0 (chapter 5)
 * in the order given by the Compatibility Check Manual v1.0 §7.5.2, plus the
 * merge of the answer history (§7.5.3: agreed / conflict / resolved). 2.2 does
 * not vote: it produces the mapping table; 2.3 judges the mappings and 2.4
 * judges coverage.
 */
import { registryRows, unitOf, type RegistryRow } from "./data.ts";
import { fieldMap, normaliseName, parentOf } from "./fields.ts";
import { sequenceRatio } from "../compatibility/sequence-ratio.ts";
import type { AmbiguousField, AppliedChoice, Candidate, ConflictAnswer, ConflictField, Field, Mapping, NotFoundField, SemanticsResult, UserChoice } from "./types.ts";

/** Role words (Semantic Manual chapter 2). */
const ROLE_WORDS = new Set([
  "seller", "buyer", "supplier", "customer", "vendor", "issuer", "receiver", "recipient", "sender", "emisor", "receptor", "spplr", "cust",
]);
/** Role words that mean the same party (rule S-5 compares ownership, not spelling). */
const ROLE_CANON: Record<string, string> = {
  seller: "seller", supplier: "seller", vendor: "seller", issuer: "seller", sender: "seller", emisor: "seller", spplr: "seller",
  buyer: "buyer", customer: "buyer", receiver: "buyer", recipient: "buyer", receptor: "buyer", cust: "buyer",
};
/** Names that are envelope or business fields depending on the parent (rule S-1). */
const DUAL_NAMES = new Set(["status", "reference", "code", "version", "index", "timestamp", "user"]);
/** Tokens whose presence on one side only signals a representation difference (rule S-7). */
const REPRESENTATION_TOKENS = new Set(["code", "id", "name", "utc", "withvat", "excludingvat", "includingvat", "incl", "excl", "net", "gross"]);
/** Owners for which ownership must be established from a cue (rule S-5). */
const PARTY_OWNERS = new Set(["party", "party_by_role", "party_address", "party_seller", "party_buyer"]);
const SUGGESTION_THRESHOLD = 0.8;

export function tokenise(leaf: string): string[] {
  return leaf
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

function roleCue(leaf: string): string | null {
  for (const t of tokenise(leaf)) if (ROLE_WORDS.has(t)) return ROLE_CANON[t];
  const lower = leaf.toLowerCase();
  for (const r of ROLE_WORDS) if (lower.startsWith(r) && lower.length > r.length) return ROLE_CANON[r];
  return null;
}

interface SideContext {
  vendor: string;
  fields: Map<string, Field>;
}

function ancestors(field: Field, side: SideContext): Field[] {
  const out: Field[] = [];
  let p = field.parent;
  while (p !== null) {
    const f = side.fields.get(p);
    if (f) out.push(f);
    p = parentOf(p);
  }
  return out;
}

/**
 * Registry rows that apply to this occurrence of a name (S-3/S-4 precedence,
 * data README): parent-condition hits, then vendor-condition hits, then rows
 * without conditions. Rows with conditions that do not match are ignored.
 */
export function applicableRows(field: Field, side: SideContext): RegistryRow[] {
  const rows = registryRows(field.name);
  if (rows.length === 0) return [];
  const chain = [field.parent ? side.fields.get(field.parent) : undefined, ...ancestors(field, side).slice(1)]
    .filter((f): f is Field => !!f)
    .map((f) => f.name);
  const vendor = side.vendor.toLowerCase();
  const parentHit = (r: RegistryRow) =>
    r.parent_condition !== "" && r.parent_condition.split("|").some((p) => chain.includes(p.trim().toLowerCase()));
  const vendorHit = (r: RegistryRow) =>
    r.vendor_condition !== "" && r.vendor_condition.split("|").some((v) => vendor.includes(v.trim().toLowerCase()));
  const byParent = rows.filter((r) => parentHit(r) && (r.vendor_condition === "" || vendorHit(r)));
  if (byParent.length > 0) return byParent;
  const byVendor = rows.filter((r) => r.parent_condition === "" && vendorHit(r));
  if (byVendor.length > 0) return byVendor;
  return rows.filter((r) => r.parent_condition === "" && r.vendor_condition === "");
}

/**
 * Rule S-9: exactly one admissible value. Applied only where the field would
 * otherwise be not found: the caller fills a constant in, so no source field
 * is needed. A constant that does have a source candidate keeps its mapping and
 * Check 3 compares the values (a source that only yields INV-001 must not feed
 * a target that only accepts INV-002).
 */
export function isConstant(field: Field): boolean {
  return Array.isArray(field.enumValues) && field.enumValues.length === 1;
}

/**
 * S-5b: the field table stores an array twice, the array (`documents`) and its
 * element (`documents[]`), under one name and one unit, so both reach the
 * candidate list. They cannot stand in for one another: when both are
 * candidates, an array target keeps the array and an array-element target
 * keeps the element. Any other target, and candidates on other paths, are
 * left alone.
 */
function sameShapeOnly(target: Field, cands: Candidate[], src: SideContext): Candidate[] {
  if (cands.length < 2) return cands;
  const targetIsArray = target.jsonType === "array" && !target.path.endsWith("[]");
  const targetIsElement = target.path.endsWith("[]");
  if (!targetIsArray && !targetIsElement) return cands;
  const paths = new Set(cands.map((c) => c.source_path));
  return cands.filter((c) => {
    const s = src.fields.get(c.source_path);
    if (!s) return true;
    if (s.jsonType === "array" && !s.path.endsWith("[]") && paths.has(s.path + "[]")) return targetIsArray;
    if (s.path.endsWith("[]") && paths.has(s.path.slice(0, -2))) return targetIsElement;
    return true;
  });
}

/** Semantic units (not E, not G) of a field. */
function unitsOf(field: Field, side: SideContext): Set<string> {
  return new Set(applicableRows(field, side).map((r) => r.unit_id).filter((u) => u !== "E" && u !== "G"));
}

/**
 * Units of a parent path. The extractor stores a row for every object node,
 * but a schema transcribed by hand may lack it; then the leaf name of the
 * path is looked up on its own.
 */
function unitsOfPath(path: string, side: SideContext): Set<string> {
  const f = side.fields.get(path);
  if (f) return unitsOf(f, side);
  const leaf = path.split(".").at(-1)!.replace(/\[\]$/, "");
  const pseudo: Field = { path, leaf, name: normaliseName(leaf), parent: parentOf(path), jsonType: "object", format: null, required: false, arrayItem: false, depth: 0, enumValues: null, description: null, isParameter: false };
  return unitsOf(pseudo, side);
}

function isEnvelope(field: Field, side: SideContext, rows: RegistryRow[]): boolean {
  const envelopeRows = rows.filter((r) => r.unit_id === "E");
  if (envelopeRows.length === 0) return false;
  if (envelopeRows.length === rows.length) return true;
  // Dual names: the parent decides (rule S-1).
  if (DUAL_NAMES.has(field.name)) {
    const parent = field.parent ? side.fields.get(field.parent) : undefined;
    if (!parent) return false;
    return applicableRows(parent, side).some((r) => r.unit_id === "E");
  }
  return false;
}

/**
 * Ownership of a field (rule S-5): a role word in the name or in an ancestor,
 * else the semantic unit of the nearest registered ancestor, else top level.
 */
type Ownership = { kind: "role"; value: string } | { kind: "unit"; value: string } | { kind: "top" } | { kind: "path"; value: string };

function ownership(field: Field, side: SideContext): Ownership {
  const own = roleCue(field.leaf);
  if (own) return { kind: "role", value: own };
  for (const a of ancestors(field, side)) {
    const cue = roleCue(a.leaf);
    if (cue) return { kind: "role", value: cue };
  }
  if (field.isParameter || field.parent === null) return { kind: "top" };
  for (let p: string | null = field.parent; p !== null; p = parentOf(p)) {
    const leaf = p.split(".").at(-1)!.replace(/\[\]$/, "");
    const cue = roleCue(leaf);
    if (cue) return { kind: "role", value: cue };
    const u = unitsOfPath(p, side);
    if (u.size > 0) return { kind: "unit", value: [...u].sort()[0] };
  }
  const parent = field.parent ? side.fields.get(field.parent) : undefined;
  return { kind: "path", value: parent ? parent.name : field.parent! };
}

function sameOwnership(a: Ownership, b: Ownership): boolean | null {
  if (a.kind === "top" || b.kind === "top") return null; // cannot be inferred
  if (a.kind !== b.kind) return a.kind === "path" || b.kind === "path" ? null : false;
  return (a as { value: string }).value === (b as { value: string }).value;
}

function tokenOverlap(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  const ta = new Set(tokenise(a));
  const tb = new Set(tokenise(b));
  let n = 0;
  for (const t of ta) if (tb.has(t)) n++;
  return n;
}

function enumOverlap(a: readonly string[] | null, b: readonly string[] | null): number {
  if (!a || !b) return 0;
  const sb = new Set(b.map((v) => String(v).toLowerCase()));
  return a.filter((v) => sb.has(String(v).toLowerCase())).length;
}

/** Narrow a candidate list by the strongest available evidence; returns the survivors. */
function narrowBy<T>(items: T[], score: (t: T) => number): T[] {
  if (items.length <= 1) return items;
  const scored = items.map((t) => [t, score(t)] as const);
  const max = Math.max(...scored.map(([, s]) => s));
  if (max <= 0) return items;
  return scored.filter(([, s]) => s === max).map(([t]) => t);
}

function shapeOf(field: Field): "array" | "object" | "value" {
  if (field.jsonType === "array") return "array";
  if (field.jsonType === "object") return "object";
  return "value";
}

/** Rule S-7 annotations for a determined mapping. */
export function annotations(target: Field, source: Field, rows: RegistryRow[]): string[] {
  const notes: string[] = [];
  const tt = new Set(tokenise(target.leaf).filter((t) => REPRESENTATION_TOKENS.has(t)));
  const st = new Set(tokenise(source.leaf).filter((t) => REPRESENTATION_TOKENS.has(t)));
  // The same name spelt differently (filename / fileName) is one name, not a
  // representation difference: tokenising splits only the camel-cased spelling.
  const sameName = target.name === source.name;
  const diff = sameName ? [] : [...tt].filter((t) => !st.has(t)).concat([...st].filter((t) => !tt.has(t)));
  const fmt = (f: Field) => (f.format ?? "").toLowerCase();
  if (diff.length > 0 || (fmt(target) !== fmt(source) && (fmt(target) || fmt(source)))) notes.push("representation_differs");
  if ((target.enumValues && !source.enumValues) || (!target.enumValues && source.enumValues)) notes.push("representation_differs");
  if (shapeOf(target) !== shapeOf(source) || target.arrayItem !== source.arrayItem) notes.push("shape_differs");
  for (const r of rows) if (/\bA3\b/.test(r.case_type)) notes.push(`split_merge: ${r.note}`);
  return [...new Set(notes)];
}

export interface SemanticsInput {
  sourceVendor: string;
  targetVendor: string;
  sourceFields: readonly Field[];
  targetFields: readonly Field[];
  choices?: readonly UserChoice[];
  /** Choices found stale by the caller (hash mismatch); reported, not applied. */
  staleChoices?: SemanticsResult["stale_choices"];
}

export function runSemantics(input: SemanticsInput): SemanticsResult {
  const src: SideContext = { vendor: input.sourceVendor, fields: fieldMap(input.sourceFields) };
  const tgt: SideContext = { vendor: input.targetVendor, fields: fieldMap(input.targetFields) };

  // Index the source once: unit -> fields, name -> fields (envelope fields excluded).
  const sourceByUnit = new Map<string, Field[]>();
  const sourceByName = new Map<string, Field[]>();
  const sourceBusiness: Field[] = [];
  for (const f of input.sourceFields) {
    const rows = applicableRows(f, src);
    if (isEnvelope(f, src, rows)) continue;
    sourceBusiness.push(f);
    (sourceByName.get(f.name) ?? sourceByName.set(f.name, []).get(f.name)!).push(f);
    for (const r of rows) if (r.unit_id !== "E" && r.unit_id !== "G") (sourceByUnit.get(r.unit_id) ?? sourceByUnit.set(r.unit_id, []).get(r.unit_id)!).push(f);
  }

  const mappings: Mapping[] = [];
  const ambiguous: AmbiguousField[] = [];
  const notFound: NotFoundField[] = [];
  const excluded: SemanticsResult["excluded"] = [];
  const usedBy = new Map<string, string[]>();

  const candidate = (f: Field, unit: string, basis: string): Candidate => ({ source_path: f.path, unit_id: unit, basis, source_type: f.jsonType, source_format: f.format, source_required: f.required });

  for (const t of input.targetFields) {
    const rows = applicableRows(t, tgt);
    // S-1
    if (isEnvelope(t, tgt, rows)) {
      excluded.push({ path: t.path, reason: "envelope" });
      continue;
    }
    const units = new Set(rows.map((r) => r.unit_id).filter((u) => u !== "E" && u !== "G"));
    const generic = rows.some((r) => r.unit_id === "G") && units.size === 0;

    // S-3: unregistered name -> not found, with reference candidates only;
    // S-9: unless the field is a constant, which the caller fills in.
    if (rows.length === 0 || (units.size === 0 && !generic)) {
      if (isConstant(t)) excluded.push({ path: t.path, reason: "constant" });
      else notFound.push({ target_path: t.path, target_type: t.jsonType, target_format: t.format, required: t.required, suggestions: suggestions(t, sourceBusiness) });
      continue;
    }

    let cands: Candidate[] = [];
    if (generic) {
      // S-4: a generic name matches the same name in the source under a parent of the same unit,
      // then by vendor (same name, same side context), then by description / enum overlap.
      const same = sourceByName.get(t.name) ?? [];
      const tParentUnits = t.parent ? unitsOfPath(t.parent, tgt) : new Set<string>();
      let pool = same.filter((s) => {
        const sParentUnits = s.parent ? unitsOfPath(s.parent, src) : new Set<string>();
        if (tParentUnits.size === 0 && sParentUnits.size === 0) return t.parent === null && s.parent === null;
        for (const u of tParentUnits) if (sParentUnits.has(u)) return true;
        return false;
      });
      if (pool.length === 0 && t.parent === null) pool = same.filter((s) => s.parent === null);
      pool = narrowBy(pool, (s) => tokenOverlap(t.description, s.description));
      pool = narrowBy(pool, (s) => enumOverlap(t.enumValues, s.enumValues));
      cands = pool.map((s) => candidate(s, "G", "generic name, parent unit"));
    } else {
      // S-3 hit(s): every source field of the same unit(s) …
      const seen = new Set<string>();
      for (const u of units) {
        for (const s of sourceByUnit.get(u) ?? []) {
          if (seen.has(s.path)) continue;
          seen.add(s.path);
          cands.push(candidate(s, u, `unit ${u} (${unitOf(u)?.name ?? u})`));
        }
      }
      // … S-5: kept only when the ownership agrees.
      if (cands.length > 0) {
        const tOwn = ownership(t, tgt);
        const partyUnit = [...units].some((u) => PARTY_OWNERS.has(unitOf(u)?.owner ?? ""));
        const agree: Candidate[] = [];
        let undecided = false;
        for (const c of cands) {
          const s = src.fields.get(c.source_path)!;
          const same = sameOwnership(tOwn, ownership(s, src));
          if (same === true) agree.push(c);
          else if (same === null) {
            // Ownership cannot be inferred on a side: acceptable when the unit's owner is not a party
            // (the unit itself fixes the ownership), otherwise the field is ambiguous.
            if (!partyUnit) agree.push(c);
            else undecided = true;
          }
        }
        if (agree.length === 0 && undecided) {
          ambiguous.push({ target_path: t.path, target_type: t.jsonType, target_format: t.format, required: t.required, candidates: cands });
          continue;
        }
        cands = agree.length > 0 ? agree : [];
        if (cands.length > 1) {
          cands = narrowBy(cands, (c) => tokenOverlap(t.description, src.fields.get(c.source_path)!.description));
        }
      }
    }

    // S-5b: an array and its own element are never both offered.
    cands = sameShapeOnly(t, cands, src);

    // S-6 (S-9: a constant with no candidate is excluded, not "not found")
    if (cands.length === 0) {
      if (isConstant(t)) excluded.push({ path: t.path, reason: "constant" });
      else notFound.push({ target_path: t.path, target_type: t.jsonType, target_format: t.format, required: t.required, suggestions: suggestions(t, sourceBusiness) });
    } else if (cands.length === 1) {
      const s = src.fields.get(cands[0].source_path)!;
      mappings.push({ target_path: t.path, source_path: s.path, unit_id: cands[0].unit_id, origin: "auto", notes: annotations(t, s, rows) });
      (usedBy.get(s.path) ?? usedBy.set(s.path, []).get(s.path)!).push(t.path);
    } else {
      ambiguous.push({ target_path: t.path, target_type: t.jsonType, target_format: t.format, required: t.required, candidates: cands });
    }
  }

  // S-6 contention: one source field determined for two or more target fields.
  for (const [sourcePath, targets] of usedBy) {
    if (targets.length < 2) continue;
    for (const tp of targets) {
      const i = mappings.findIndex((m) => m.target_path === tp);
      if (i < 0) continue;
      const m = mappings.splice(i, 1)[0];
      const t = tgt.fields.get(tp)!;
      const contestedSource = src.fields.get(sourcePath)!;
      ambiguous.push({
        target_path: tp,
        target_type: t.jsonType,
        target_format: t.format,
        required: t.required,
        candidates: [{
          source_path: sourcePath,
          unit_id: m.unit_id,
          basis: `contention: also determined for ${targets.filter((x) => x !== tp).join(", ")}`,
          source_type: contestedSource.jsonType,
          source_format: contestedSource.format,
          source_required: contestedSource.required,
        }],
      });
    }
  }

  // 2.2c — merge the answer history per field, then apply or hold.
  const uncoveredByChoice: string[] = [];
  const externalByChoice: string[] = [];
  const applied: AppliedChoice[] = [];
  const conflicts: ConflictField[] = [];
  const answerOf = (c: UserChoice): ConflictAnswer => ({
    source: c.kind === "admin" ? "admin" : "user",
    option: c.option,
    chosen_source_path: c.option === "candidate" ? c.chosen_source_path ?? null : null,
    chosen_by: c.chosen_by ?? null,
    chosen_at: c.chosen_at ?? null,
  });
  const key = (a: { option: string; chosen_source_path: string | null }) => `${a.option}\u0000${a.chosen_source_path ?? ""}`;
  const history = new Map<string, UserChoice[]>();
  for (const c of input.choices ?? []) (history.get(c.target_path) ?? history.set(c.target_path, []).get(c.target_path)!).push(c);

  for (const [path, rows] of history) {
    const t = tgt.fields.get(path);
    if (!t) continue;
    const byTime = [...rows].sort((a, b) => (a.chosen_at ?? "").localeCompare(b.chosen_at ?? ""));
    const admin = byTime.filter((c) => c.kind === "admin").at(-1);
    const users = byTime.filter((c) => c.kind !== "admin");
    const autoIndex = mappings.findIndex((m) => m.target_path === path && m.origin === "auto");
    const auto = autoIndex >= 0 ? mappings[autoIndex] : null;
    const ai = ambiguous.findIndex((a) => a.target_path === path);
    const ni = notFound.findIndex((n) => n.target_path === path);

    let chosen: UserChoice | null = null;
    let state: AppliedChoice["state"] | "conflict" = "conflict";
    if (admin) {
      chosen = admin;
      state = "resolved";
    } else {
      const distinct = new Map(users.map((c) => [key(answerOf(c)), c]));
      if (distinct.size === 1) {
        chosen = users.at(-1)!;
        state = "agreed";
      }
    }

    // An agreed user answer that disagrees with the registry's automatic match is a conflict too
    // (an administrator's answer is final and overrides the registry).
    const registryAnswer: ConflictAnswer | null = auto
      ? { source: "registry", option: "candidate", chosen_source_path: auto.source_path, chosen_by: null, chosen_at: null }
      : null;
    if (state === "agreed" && registryAnswer && key(registryAnswer) !== key(answerOf(chosen!))) state = "conflict";

    if (state === "conflict") {
      const answers = users.map(answerOf);
      if (registryAnswer) answers.unshift(registryAnswer);
      conflicts.push({ target_path: path, required: t.required, answers });
      if (autoIndex >= 0) mappings.splice(autoIndex, 1);
      if (ai >= 0) ambiguous.splice(ai, 1);
      if (ni >= 0) notFound.splice(ni, 1);
      continue;
    }

    // Apply the merged answer.
    const c = chosen!;
    if (auto && key(registryAnswer!) === key(answerOf(c))) {
      applied.push({ target_path: path, state, option: c.option, chosen_source_path: auto.source_path });
      continue; // consistent with the automatic match: nothing to change
    }
    if (autoIndex >= 0) mappings.splice(autoIndex, 1); // an administrator overrides the registry
    if (ai >= 0) ambiguous.splice(ai, 1);
    if (ni >= 0) notFound.splice(ni, 1);
    if (c.option === "candidate" && c.chosen_source_path && src.fields.has(c.chosen_source_path)) {
      const s = src.fields.get(c.chosen_source_path)!;
      const rowsT = applicableRows(t, tgt);
      const unit = [...new Set(rowsT.map((r) => r.unit_id).filter((u) => u !== "E" && u !== "G"))][0] ?? "";
      mappings.push({ target_path: t.path, source_path: s.path, unit_id: unit, origin: "user_choice", notes: annotations(t, s, rowsT) });
    } else if (c.option === "external") {
      externalByChoice.push(path);
    } else {
      uncoveredByChoice.push(path);
    }
    applied.push({ target_path: path, state, option: c.option, chosen_source_path: c.option === "candidate" ? c.chosen_source_path ?? null : null });
  }

  // A required container (object or array with child fields) whose children
  // are already matched does not need an answer of its own: 2.4 rule (4)
  // decides it by its children. This is how the previous API's whole JSON
  // response, nested in one field of the next request (the group's
  // extracted-invoice endpoint takes Upbrains' result as `extraction`), is
  // recognised: the field names match underneath, and the wrapper is not a
  // business input. Decided 14 October 2026.
  const hasChildren = (path: string) => [...tgt.fields.values()].some((f) => f.parent === path);
  const hasMappedDescendant = (path: string) =>
    mappings.some((m) => m.target_path.startsWith(path + ".") || m.target_path.startsWith(path + "[]"));
  for (const entry of [...ambiguous, ...notFound]) {
    const t = tgt.fields.get(entry.target_path);
    if (!entry.required || !t || (t.jsonType !== "object" && t.jsonType !== "array")) continue;
    if (hasChildren(t.path) && hasMappedDescendant(t.path)) entry.required = false; // the page still offers it, as optional
  }

  // Required fields first in both lists (S-8).
  const byRequired = <T extends { required: boolean; target_path: string }>(a: T, b: T) =>
    Number(b.required) - Number(a.required) || a.target_path.localeCompare(b.target_path);
  ambiguous.sort(byRequired);
  notFound.sort(byRequired);

  const pendingAdmin = conflicts.some((c) => c.required);
  const pendingUser = ambiguous.some((a) => a.required) || notFound.some((n) => n.required);
  return {
    status: pendingAdmin ? "pending_admin" : pendingUser ? "pending_user" : "complete",
    mappings,
    ambiguous,
    not_found: notFound,
    excluded,
    uncovered_by_choice: uncoveredByChoice,
    external_by_choice: externalByChoice,
    stale_choices: [...(input.staleChoices ?? [])],
    applied,
    conflicts,
  };
}

/** Rule S-6: string-similarity reference candidates for a not-found field; never a match. */
function suggestions(target: Field, sourceFields: readonly Field[]): Candidate[] {
  const scored = sourceFields
    .map((s) => ({ s, r: sequenceRatio(target.name, s.name) }))
    .filter(({ r }) => r >= SUGGESTION_THRESHOLD)
    .sort((a, b) => b.r - a.r)
    .slice(0, 3);

  return scored.map(({ s, r }) => ({source_path: s.path,unit_id: "",basis: `string similarity ${r.toFixed(2)} (reference only)`,source_type: s.jsonType,source_format: s.format,source_required: s.required,}));
}
