/**
 * The workflow canvas draws the state machine the Step Functions generator
 * returns (`/api/composition/workflow?format=json`), not a picture of its
 * own: every state of the definition is one node and every transition one
 * edge, so the canvas shows what AWS will show. The definition is read as
 * Amazon States Language, without assuming which states the generator
 * writes, so later changes to the generator (Pass, Catch, Parallel) still
 * appear.
 *
 * Pure: no React, no network.
 */
import { STEP_CATEGORIES, type StepCategory } from "../composition/types.ts";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type AslState = Record<string, Json>;
export interface AslDefinition {
  Comment?: string;
  StartAt: string;
  States: Record<string, AslState>;
}

/** One Lambda function of the generated package, without its files. */
export interface WorkflowLambdaView {
  order: number;
  api_id: string | null;
  api_name: string;
  company_name: string;
  category: StepCategory | "Mapping";
  function_name: string;
  arn_placeholder: string;
  runtime: string;
  handler: string;
  timeout_seconds: number;
  environment: Record<string, string>;
  setup: string[];
  /** The Secrets Manager secret the function reads, if its API needs a credential. */
  secret?: string | null;
  /** How the function builds its request (workflow-calls.ts); null for an adapter. */
  call?: {
    request: { kind: "body" | "file" | "base64" | "json"; media: string | null; field: string | null; fixed: Record<string, string | number | boolean>; required: string[] };
    response: { kind: "text" | "body" | "json"; field: string | null };
    from_schema: { request: boolean; response: boolean };
  } | null;
  /** The stored request's top-level fields; null when none is stored or for an adapter. */
  request_fields?: Array<{ name: string; required: boolean; type: string | null }> | null;
}

export type CanvasNodeKind = "start" | "end" | "api" | "adapter" | "choice" | "fail" | "succeed" | "pass" | "state";

export interface CanvasNode {
  id: string;
  kind: CanvasNodeKind;
  /** The state's name, as the AWS console shows it. */
  label: string;
  /** The ASL type ("Task", "Choice"…); empty for Start and End. */
  stateType: string;
  lambda: WorkflowLambdaView | null;
  category: StepCategory | null;
  state: AslState | null;
}

export type CanvasEdgeKind = "next" | "choice" | "default" | "catch" | "end";

export interface CanvasEdge {
  id: string;
  from: string;
  to: string;
  kind: CanvasEdgeKind;
  label: string;
}

export interface CanvasGraph {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export const START_ID = "__start__";
export const END_ID = "__end__";

function isObject(value: Json | undefined): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function categoryOf(value: string): StepCategory | null {
  return STEP_CATEGORIES.find((category) => category === value) ?? null;
}

/** The Lambda a Task calls: the one whose ARN placeholder appears in the state. */
function lambdaFor(state: AslState, lambdas: readonly WorkflowLambdaView[]): WorkflowLambdaView | null {
  const text = JSON.stringify(state);
  return lambdas.find((lambda) => text.includes(lambda.arn_placeholder)) ?? null;
}

function lastSegment(path: Json | undefined): string {
  return typeof path === "string" ? path.split(".").at(-1) ?? path : "value";
}

const COMPARATORS: Array<[RegExp, string]> = [
  [/^(String|Numeric|Boolean|Timestamp)Equals(Path)?$/, "="],
  [/^(String|Numeric|Timestamp)LessThan(Path)?$/, "<"],
  [/^(String|Numeric|Timestamp)GreaterThan(Path)?$/, ">"],
  [/^(String|Numeric|Timestamp)LessThanEquals(Path)?$/, "≤"],
  [/^(String|Numeric|Timestamp)GreaterThanEquals(Path)?$/, "≥"],
  [/^StringMatches$/, "matches"],
];

/** The comparisons of a Choice rule, leaves first; presence and type tests are kept apart. */
function leaves(rule: Json | undefined): Array<{ text: string; test: boolean }> {
  if (!isObject(rule)) return [];
  for (const key of ["And", "Or"] as const) {
    const list = rule[key];
    if (Array.isArray(list)) return list.flatMap((item) => leaves(item));
  }
  if (isObject(rule.Not)) return leaves(rule.Not).map((leaf) => ({ ...leaf, text: `not ${leaf.text}` }));
  const name = lastSegment(rule.Variable);
  for (const [key, value] of Object.entries(rule)) {
    if (key === "Variable" || key === "Next") continue;
    if (/^Is(Present|Null|Boolean|String|Numeric|Timestamp)$/.test(key)) {
      return [{ text: `${name} ${key === "IsPresent" ? "is present" : `is ${key.slice(2).toLowerCase()}`}`, test: true }];
    }
    const comparator = COMPARATORS.find(([pattern]) => pattern.test(key));
    if (comparator) return [{ text: `${name} ${comparator[1]} ${JSON.stringify(value)}`, test: false }];
  }
  return [{ text: "rule", test: false }];
}

/** A short label for a Choice rule: its comparisons, without the presence checks that guard them. */
export function choiceLabel(rule: Json | undefined): string {
  const all = leaves(rule);
  const shown = all.some((leaf) => !leaf.test) ? all.filter((leaf) => !leaf.test) : all;
  const text = shown.map((leaf) => leaf.text).join(" and ");
  // "document is present and not document is null", an input check, reads as one test.
  const given = /^(\S+) is present and not \1 is null$/.exec(text);
  return given ? `${given[1]} is given` : text || "rule";
}

function nodeKind(state: AslState, lambda: WorkflowLambdaView | null): CanvasNodeKind {
  switch (state.Type) {
    case "Task": return lambda?.category === "Mapping" ? "adapter" : lambda ? "api" : "state";
    case "Choice": return "choice";
    case "Fail": return "fail";
    case "Succeed": return "succeed";
    case "Pass": return "pass";
    default: return "state";
  }
}

/** Every state as a node, between a Start and an End, with each transition as an edge. */
export function graphFromDefinition(definition: AslDefinition, lambdas: readonly WorkflowLambdaView[] = []): CanvasGraph {
  const nodes: CanvasNode[] = [{ id: START_ID, kind: "start", label: "Start", stateType: "", lambda: null, category: null, state: null }];
  const edges: CanvasEdge[] = [];
  const names = Object.keys(definition.States ?? {});
  const add = (from: string, to: Json | undefined, kind: CanvasEdgeKind, label = "") => {
    if (typeof to !== "string" || !(to in definition.States)) return;
    edges.push({ id: `${from}->${to}:${kind}:${edges.length}`, from, to, kind, label });
  };
  if (definition.StartAt in (definition.States ?? {})) {
    edges.push({ id: `${START_ID}->${definition.StartAt}`, from: START_ID, to: definition.StartAt, kind: "next", label: "" });
  }
  let reachesEnd = false;
  for (const name of names) {
    const state = definition.States[name];
    const lambda = state.Type === "Task" ? lambdaFor(state, lambdas) : null;
    const kind = nodeKind(state, lambda);
    nodes.push({
      id: name, kind, label: name, stateType: typeof state.Type === "string" ? state.Type : "",
      lambda, category: lambda ? categoryOf(lambda.category) : null, state,
    });
    add(name, state.Next, "next");
    if (Array.isArray(state.Choices)) {
      for (const rule of state.Choices) if (isObject(rule)) add(name, rule.Next, "choice", choiceLabel(rule));
    }
    add(name, state.Default, "default", "Otherwise");
    if (Array.isArray(state.Catch)) {
      for (const handler of state.Catch) {
        if (!isObject(handler)) continue;
        const errors = Array.isArray(handler.ErrorEquals) ? handler.ErrorEquals.filter((error) => typeof error === "string") : [];
        add(name, handler.Next, "catch", errors.length === 1 && errors[0] === "States.ALL" ? "On error" : `On ${errors.join(", ") || "error"}`);
      }
    }
    if (state.End === true || state.Type === "Succeed" || state.Type === "Fail") {
      edges.push({ id: `${name}->${END_ID}`, from: name, to: END_ID, kind: "end", label: "" });
      reachesEnd = true;
    }
  }
  if (reachesEnd || names.length === 0) {
    nodes.push({ id: END_ID, kind: "end", label: "End", stateType: "", lambda: null, category: null, state: null });
  }
  if (names.length === 0) edges.push({ id: `${START_ID}->${END_ID}`, from: START_ID, to: END_ID, kind: "end", label: "" });
  return { nodes, edges };
}

export interface NodeBox { x: number; y: number; width: number; height: number }

export const NODE_SIZE: Record<CanvasNodeKind, { width: number; height: number }> = {
  start: { width: 88, height: 34 },
  end: { width: 88, height: 34 },
  api: { width: 260, height: 76 },
  adapter: { width: 260, height: 60 },
  choice: { width: 220, height: 56 },
  fail: { width: 200, height: 56 },
  succeed: { width: 200, height: 52 },
  pass: { width: 220, height: 52 },
  state: { width: 220, height: 56 },
};

const ROW_GAP = 56;
const COLUMN_GAP = 64;

/**
 * Top-to-bottom layout, as the AWS console draws a state machine: each node
 * sits one row below the furthest node that leads to it, and the nodes of a
 * row are placed left to right in the order the main path reaches them, so
 * the success path runs down one column and failure states sit beside it.
 * Loops are ignored for the ranking. Positions are each box's top-left corner.
 */
export function layoutGraph(graph: CanvasGraph): Record<string, NodeBox> {
  const outgoing = new Map<string, CanvasEdge[]>();
  for (const node of graph.nodes) outgoing.set(node.id, []);
  // The main path first: transitions, then the first branch, then defaults and error handlers.
  const priority: Record<CanvasEdgeKind, number> = { next: 0, choice: 1, end: 2, default: 3, catch: 4 };
  for (const edge of graph.edges) outgoing.get(edge.from)?.push(edge);
  for (const list of outgoing.values()) list.sort((a, b) => priority[a.kind] - priority[b.kind]);

  // Depth-first order from Start; back edges (to a node still on the stack) are dropped.
  const order: string[] = [];
  const state = new Map<string, "open" | "done">();
  const forward: CanvasEdge[] = [];
  const visit = (id: string) => {
    state.set(id, "open");
    for (const edge of outgoing.get(id) ?? []) {
      if (state.get(edge.to) === "open") continue;
      forward.push(edge);
      if (!state.has(edge.to)) visit(edge.to);
    }
    state.set(id, "done");
    order.push(id);
  };
  visit(START_ID);
  for (const node of graph.nodes) if (!state.has(node.id)) visit(node.id);
  order.reverse();

  // Longest path from Start over forward edges; End goes below everything.
  const rank = new Map<string, number>(order.map((id) => [id, 0]));
  for (const id of order) {
    for (const edge of forward) if (edge.from === id) rank.set(edge.to, Math.max(rank.get(edge.to)!, rank.get(id)! + 1));
  }
  const deepest = Math.max(0, ...[...rank].filter(([id]) => id !== END_ID).map(([, value]) => value));
  if (rank.has(END_ID)) rank.set(END_ID, deepest + 1);

  // Main-path order within a row: the depth-first discovery order.
  const discovered: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    discovered.push(id);
    for (const edge of outgoing.get(id) ?? []) walk(edge.to);
  };
  walk(START_ID);
  for (const node of graph.nodes) walk(node.id);

  const kindOf = new Map(graph.nodes.map((node) => [node.id, node.kind]));
  const rows = new Map<number, string[]>();
  for (const id of discovered) {
    const r = rank.get(id) ?? 0;
    rows.set(r, [...(rows.get(r) ?? []), id]);
  }
  const mainWidth = NODE_SIZE.api.width;
  const boxes: Record<string, NodeBox> = {};
  let y = 0;
  for (const r of [...rows.keys()].sort((a, b) => a - b)) {
    const ids = rows.get(r)!;
    const height = Math.max(...ids.map((id) => NODE_SIZE[kindOf.get(id)!].height));
    let x = 0;
    ids.forEach((id, index) => {
      const size = NODE_SIZE[kindOf.get(id)!];
      // The first node of a row is centred on the main column; the others follow to its right.
      // A Fail state always sits beside it, so error handlers never run down the main column.
      const left = index === 0 && kindOf.get(id) !== "fail" ? (mainWidth - size.width) / 2 : Math.max(x, mainWidth + COLUMN_GAP);
      boxes[id] = { x: left, y: y + (height - size.height) / 2, width: size.width, height: size.height };
      x = Math.max(mainWidth, left + size.width) + COLUMN_GAP;
    });
    y += height + ROW_GAP;
  }
  return boxes;
}
