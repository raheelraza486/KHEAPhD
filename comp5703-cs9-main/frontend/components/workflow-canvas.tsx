"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import GenerateWorkflowButton from "@/components/generate-workflow-button";
import DeployPanel, { type DeployView } from "@/components/workflow-canvas-deploy";
import { STEP_CATEGORIES, type StepCategory } from "@/lib/composition/types";
import { addApi, chainProblems, connectionPairs, moveApi, removeApi, replaceApi, type CanvasApi, type ChainEdit } from "@/lib/workflow-canvas/chain";
import {
  END_ID, START_ID, choiceLabel, graphFromDefinition, layoutGraph,
  type AslDefinition, type CanvasEdge, type CanvasNode, type NodeBox, type WorkflowLambdaView,
} from "@/lib/workflow-canvas/graph";
import { SERVER_FILLED, type DeployParameterView, type RunState } from "@/lib/workflow-canvas/deployment";
import { stepInputs, type InputSource } from "@/lib/workflow-canvas/inputs";
import styles from "./workflow-canvas.module.css";

/**
 * The workflow canvas: the chosen chain drawn as the AWS Step Functions state
 * machine it becomes. APIs are dragged in from the library, dropped on a step
 * to replace it, moved or removed; after each edit the Step Functions
 * generator (/api/composition/workflow) builds the definition again and the
 * canvas draws that, so the diagram is the one AWS will show. Node positions
 * are the viewer's own and do not change the workflow.
 */

type LibraryApi = CanvasApi & { verified: boolean };
type Bundle = {
  name: string; warnings: string[]; definition: AslDefinition; lambdas: WorkflowLambdaView[]; files: Array<{ path: string; content: string }>;
  /** What deploying needs (#135); absent from the first generator's answer. */
  parameters?: DeployParameterView[];
  secrets?: Array<{ name: string; apis: string[]; value: string }>;
  stack_name?: string;
};

/** The definition's YAML file: statemachine.asl.yaml in the SAM package, else the one .yaml beside the README. */
function definitionYaml(files: Bundle["files"]): string {
  const yaml = files.filter((file) => file.path.endsWith(".yaml") && !/(^|\/)template\.yaml$/.test(file.path));
  return (yaml.find((file) => file.path.endsWith("statemachine.asl.yaml")) ?? yaml[0])?.content ?? "";
}

type Generation =
  | { status: "idle" }
  | { status: "loading"; key: string; previous: Bundle | null }
  | { status: "ready"; key: string; bundle: Bundle }
  | { status: "error"; key: string; message: string; previous: Bundle | null };
type Verdict = "pass" | "fail" | "pending_user" | "pending_admin" | "unknown";
type Check = { status: "loading" } | { status: "done"; verdict: Verdict; blocking: string[] } | { status: "error" } | { status: "absent"; reason: string };
type Assessment = { status: "loading" } | { status: "error" } | { status: "done"; links: Record<string, Check>; absent: string | null };
type View = { x: number; y: number; scale: number };
type Drag =
  | { type: "pan"; pointer: number; startX: number; startY: number; view: View }
  | { type: "node"; pointer: number; id: string; startX: number; startY: number; origin: { dx: number; dy: number }; moved: boolean };
type Tab = "step" | "checks" | "readiness" | "definition" | "export";
type Readiness = { label: string; state: "ready" | "check" | "blocked" | "waiting"; text: string; tab?: Tab };

const MIN_SCALE = 0.3;
const MAX_SCALE = 1.6;

const CATEGORY_LABEL: Record<StepCategory, string> = { Transformation: "Transform", Validation: "Validate", Communication: "Send" };
const CATEGORY_CLASS: Record<StepCategory, string> = {
  Transformation: styles.transformation, Validation: styles.validation, Communication: styles.communication,
};
const VERDICT_COPY: Record<Verdict, { label: string; tone: string; detail: string }> = {
  pass: { label: "Compatible", tone: styles.pass, detail: "The checks found no blocking mismatch." },
  fail: { label: "Not compatible", tone: styles.fail, detail: "A check found a mismatch these two APIs cannot get past as they are." },
  pending_user: { label: "Needs a decision", tone: styles.pending, detail: "A field mapping is waiting for a user's choice. Signed-in users can answer it on the Compatibility page." },
  pending_admin: { label: "Awaiting an administrator", tone: styles.pending, detail: "Users gave conflicting answers for a field; an administrator settles it." },
  unknown: { label: "More information needed", tone: styles.pending, detail: "A side has no stored schema, so the fields could not be compared." },
};
const EMPTY_DEFINITION: AslDefinition = { StartAt: "", States: {} };
const SOURCE_LABEL: Record<InputSource, string> = {
  document: "Document", fixed: "Fixed", parameter: "Deploy parameter", secret: "Secret", not_sent: "Not sent", no_schema: "Guess",
};
const READINESS_LABEL: Record<Readiness["state"], string> = { ready: "Ready", check: "Check", blocked: "Blocked", waiting: "…" };
const RUN_CLASS: Record<RunState, string> = {
  succeeded: styles.runSucceeded, failed: styles.runFailed, running: styles.runRunning, not_run: styles.runNotRun,
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function pairKey(from: string, to: string) {
  return `${from}>${to}`;
}

function edgePath(from: NodeBox, to: NodeBox): string {
  const sx = from.x + from.width / 2;
  const sy = from.y + from.height;
  const tx = to.x + to.width / 2;
  const ty = to.y;
  if (ty > sy) {
    const bend = Math.max(24, (ty - sy) / 2);
    return `M ${sx} ${sy} C ${sx} ${sy + bend}, ${tx} ${ty - bend}, ${tx} ${ty}`;
  }
  // A loop back up: leave from the right side and come round.
  const rx = Math.max(from.x + from.width, to.x + to.width) + 48;
  return `M ${from.x + from.width} ${from.y + from.height / 2} C ${rx} ${from.y + from.height / 2}, ${rx} ${to.y + to.height / 2}, ${to.x + to.width} ${to.y + to.height / 2}`;
}

function edgeMidpoint(from: NodeBox, to: NodeBox) {
  return { x: (from.x + from.width / 2 + to.x + to.width / 2) / 2, y: (from.y + from.height + to.y) / 2 };
}

export default function WorkflowCanvas({ initialIds, initialName, savedChainId, canDeploy = false, accountEmail }: { initialIds: string[]; initialName: string; savedChainId?: string; canDeploy?: boolean; accountEmail?: string }) {
  const privateChain = Boolean(savedChainId);
  const [library, setLibrary] = useState<LibraryApi[] | null>(null);
  const [libraryError, setLibraryError] = useState("");
  const [query, setQuery] = useState("");
  const [chain, setChain] = useState<CanvasApi[]>([]);
  const [history, setHistory] = useState<{ past: CanvasApi[][]; future: CanvasApi[][] }>({ past: [], future: [] });
  const [name, setName] = useState(initialName);
  const [generation, setGeneration] = useState<Generation>({ status: "idle" });
  const [assessments, setAssessments] = useState<Record<string, Assessment>>({});
  const [offsets, setOffsets] = useState<Record<string, { dx: number; dy: number }>>({});
  const [view, setView] = useState<View>({ x: 40, y: 24, scale: 1 });
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("step");
  const [notice, setNotice] = useState("");
  const [dropTarget, setDropTarget] = useState<number | "canvas" | null>(null);
  const [carry, setCarry] = useState<{ api: LibraryApi; x: number; y: number } | null>(null);
  const pick = useRef<{ api: LibraryApi; pointer: number; startX: number; startY: number; moving: boolean } | null>(null);
  const [definitionFormat, setDefinitionFormat] = useState<"yaml" | "json">("yaml");
  const [copied, setCopied] = useState(false);
  const [replacement, setReplacement] = useState("");
  const [run, setRun] = useState<Record<string, RunState> | null>(null);
  const [deployView, setDeployView] = useState<DeployView>({ status: "unknown" });
  const onRunStates = useCallback((states: Record<string, RunState> | null) => setRun(states), []);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const fittedFor = useRef("");

  // The catalogue: every active API of the three step categories.
  useEffect(() => {
    let live = true;
    fetch("/api/apis", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const body = await response.json() as { apis: Array<Record<string, unknown>> };
        const apis = body.apis.flatMap((api): LibraryApi[] => {
          const category = STEP_CATEGORIES.find((value) => value === api.category);
          if (!category || api.is_active === false || api.duplicate_of) return [];
          return [{
            id: String(api.id), api_name: String(api.api_name ?? ""), company_name: String(api.company_name ?? ""),
            category, verified: api.review_status === "Verified",
          }];
        }).sort((a, b) => a.api_name.localeCompare(b.api_name));
        if (!live) return;
        setLibrary(apis);
        const byId = new Map(apis.map((api) => [api.id, api]));
        const start = initialIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
        if (privateChain && start.length !== initialIds.length) {
          setNotice("This saved chain contains an API that is no longer available.");
          return;
        }
        const problems = chainProblems(start);
        if (problems.length) {
          setNotice(`The chain in the link cannot be drawn: ${problems[0]}`);
        } else {
          setChain(start);
          if (start.length < initialIds.length) {
            setNotice(`${initialIds.length - start.length} API${initialIds.length - start.length === 1 ? " in the link is" : "s in the link are"} not in the catalogue and ${initialIds.length - start.length === 1 ? "was" : "were"} left out.`);
          }
        }
      })
      .catch(() => { if (live) setLibraryError("The API library could not be loaded. Reload the page to try again."); });
    return () => { live = false; };
  }, [initialIds, privateChain]);

  const chainKey = chain.map((api) => api.id).join(",");
  const generationKey = `${chainKey}|${name}`;

  // Keep the address in step with the workflow, so it can be shared or reloaded.
  // A saved chain keeps its private link until it is edited; an edited chain
  // gets an ordinary link, so a reload keeps the edit instead of the saved version.
  const savedUnchanged = Boolean(savedChainId) && name === initialName
    && (chainKey === initialIds.join(",") || (!chainKey && history.past.length === 0));
  useEffect(() => {
    if (!library) return;
    const params = new URLSearchParams();
    if (savedUnchanged && savedChainId) params.set("saved_chain", savedChainId);
    else {
      if (chainKey) params.set("api_ids", chainKey);
      if (name) params.set("name", name);
    }
    window.history.replaceState(null, "", `${window.location.pathname}${params.size ? `?${params}` : ""}`);
  }, [library, chainKey, name, savedUnchanged, savedChainId]);

  // Each edit asks the Step Functions generator for the new definition.
  useEffect(() => {
    if (!chainKey) { setGeneration({ status: "idle" }); return; }
    const controller = new AbortController();
    setGeneration((current) => ({
      status: "loading", key: generationKey,
      previous: current.status === "ready" ? current.bundle : current.status === "idle" ? null : current.previous,
    }));
    const timer = window.setTimeout(() => {
      fetch("/api/composition/workflow?format=json", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ api_ids: chainKey.split(","), ...(name ? { name } : {}) }),
      }).then(async (response) => {
        const body = await response.json().catch(() => null) as (Bundle & { error?: string; details?: Array<{ message: string }> }) | null;
        if (!response.ok || !body?.definition) {
          const detail = body?.details?.map((issue) => issue.message).join(" ");
          throw new Error([body?.error ?? `The workflow could not be generated (${response.status}).`, detail].filter(Boolean).join(" "));
        }
        setGeneration({ status: "ready", key: generationKey, bundle: body });
      }).catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setGeneration((current) => ({
          status: "error", key: generationKey, message: error instanceof Error ? error.message : "The workflow could not be generated.",
          previous: current.status === "loading" ? current.previous : null,
        }));
      });
    }, 250);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [chainKey, generationKey, name]);

  // The connections are checked by the composition engine, as on the results
  // page: one request per chain, with each step pinned to its API, so a sender
  // after a validator is compared with the transformation before it.
  const pairs = useMemo(() => connectionPairs(chain).map(({ from, to }) => ({ from, to, key: pairKey(chain[from].id, chain[to].id) })), [chain]);
  useEffect(() => {
    if (!chainKey || pairs.length === 0 || assessments[chainKey]) return;
    const key = chainKey;
    const steps = chain;
    setAssessments((current) => ({ ...current, [key]: { status: "loading" } }));
    fetch("/api/composition", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: "1.0", input_text: `Workflow canvas: ${steps.map((api) => api.api_name).join(" → ")}`.slice(0, 2000), unmatched: [],
        steps: steps.map((api, index) => ({
          order: index + 1, category: api.category, task: api.api_name,
          input_format: null, output_format: null, rule_set: null, candidate_ids: [api.id],
        })),
      }),
    }).then(async (response) => {
      if (!response.ok) throw new Error(String(response.status));
      const body = await response.json() as {
        composition: { issues: Array<{ message: string }>; chains: Array<{ api_ids: string[]; links: Array<{ source_id: string; target_id: string; verdict: Verdict }> }> };
        technical_checks?: Array<{ source_id: string; target_id: string; blocking_checks: string[] }>;
      };
      const found = body.composition.chains.find((item) => item.api_ids.join(",") === key);
      const links: Record<string, Check> = {};
      for (const link of found?.links ?? []) {
        const technical = body.technical_checks?.find((item) => item.source_id === link.source_id && item.target_id === link.target_id);
        links[pairKey(link.source_id, link.target_id)] = { status: "done", verdict: link.verdict, blocking: technical?.blocking_checks ?? [] };
      }
      const absent = found ? null : body.composition.issues[0]?.message
        ?? "The composition engine does not offer this chain: a step lacks the input or output the next step needs, or a connection fails.";
      setAssessments((current) => ({ ...current, [key]: { status: "done", links, absent } }));
    }).catch(() => setAssessments((current) => ({ ...current, [key]: { status: "error" } })));
  }, [chain, chainKey, pairs, assessments]);
  const assessment = assessments[chainKey];
  const checks = useMemo(() => {
    const result: Record<string, Check> = {};
    for (const pair of pairs) {
      if (!assessment || assessment.status === "loading") result[pair.key] = { status: "loading" };
      else if (assessment.status === "error") result[pair.key] = { status: "error" };
      else result[pair.key] = assessment.links[pair.key] ?? { status: "absent", reason: assessment.absent ?? "This connection was not checked." };
    }
    return result;
  }, [pairs, assessment]);

  const bundle = generation.status === "ready" ? generation.bundle : generation.status === "idle" ? null : generation.previous;
  const stale = generation.status === "loading" || generation.status === "error";
  const graph = useMemo(() => graphFromDefinition(bundle && chainKey ? bundle.definition : EMPTY_DEFINITION, bundle?.lambdas ?? []), [bundle, chainKey]);
  const layout = useMemo(() => layoutGraph(graph), [graph]);
  const boxes = useMemo(() => {
    const placed: Record<string, NodeBox> = {};
    for (const [id, box] of Object.entries(layout)) {
      const offset = offsets[id];
      placed[id] = offset ? { ...box, x: box.x + offset.dx, y: box.y + offset.dy } : box;
    }
    return placed;
  }, [layout, offsets]);

  /** The chain position of each API Task, by the order of the generator's Lambdas. */
  const stepIndex = useMemo(() => {
    const index = new Map<string, number>();
    let position = 0;
    for (const node of [...graph.nodes].filter((item) => item.lambda?.api_id).sort((a, b) => a.lambda!.order - b.lambda!.order)) {
      index.set(node.id, position++);
    }
    return index;
  }, [graph]);

  const fit = useCallback(() => {
    const element = stage.current;
    const all = Object.values(boxes);
    if (!element || all.length === 0) return;
    const minX = Math.min(...all.map((box) => box.x));
    const minY = Math.min(...all.map((box) => box.y));
    const maxX = Math.max(...all.map((box) => box.x + box.width));
    const maxY = Math.max(...all.map((box) => box.y + box.height));
    const { width, height } = element.getBoundingClientRect();
    const scale = clamp(Math.min((width - 64) / (maxX - minX), (height - 64) / (maxY - minY), 1), MIN_SCALE, MAX_SCALE);
    setView({ scale, x: (width - (maxX - minX) * scale) / 2 - minX * scale, y: 32 - minY * scale });
  }, [boxes]);

  // Fit the diagram whenever its states change, not when a node is moved.
  const shapeKey = graph.nodes.map((node) => node.id).join("|");
  useEffect(() => {
    if (fittedFor.current === shapeKey) return;
    fittedFor.current = shapeKey;
    fit();
  }, [shapeKey, fit]);

  // Zoom with Ctrl or ⌘ and the wheel, around the pointer; a plain wheel scrolls the page.
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      setView((current) => {
        const scale = clamp(current.scale * Math.exp(-event.deltaY / 400), MIN_SCALE, MAX_SCALE);
        return { scale, x: px - ((px - current.x) * scale) / current.scale, y: py - ((py - current.y) * scale) / current.scale };
      });
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  function zoom(factor: number) {
    const element = stage.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    setView((current) => {
      const scale = clamp(current.scale * factor, MIN_SCALE, MAX_SCALE);
      return { scale, x: width / 2 - ((width / 2 - current.x) * scale) / current.scale, y: height / 2 - ((height / 2 - current.y) * scale) / current.scale };
    });
  }

  function apply(edit: ChainEdit, message?: string) {
    if (!edit.ok) { setNotice(edit.reason); return false; }
    setHistory((current) => ({ past: [...current.past.slice(-49), chain], future: [] }));
    setChain(edit.chain);
    setNotice(message ?? "");
    setSelected(null);
    return true;
  }

  function undo() {
    const previous = history.past.at(-1);
    if (!previous) return;
    setHistory((current) => ({ past: current.past.slice(0, -1), future: [chain, ...current.future] }));
    setChain(previous);
    setSelected(null);
    setNotice("");
  }

  function redo() {
    const next = history.future[0];
    if (!next) return;
    setHistory((current) => ({ past: [...current.past, chain], future: current.future.slice(1) }));
    setChain(next);
    setSelected(null);
    setNotice("");
  }

  // Pointer handling: drag the background to pan, drag a node to move it, click a node to select it.
  function onStagePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target as Element).closest("[data-node]")) return;
    drag.current = { type: "pan", pointer: event.pointerId, startX: event.clientX, startY: event.clientY, view };
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelected(null);
  }

  function onNodePointerDown(event: ReactPointerEvent<HTMLElement>, id: string) {
    if (event.button !== 0 || !stage.current) return;
    event.stopPropagation();
    drag.current = { type: "node", pointer: event.pointerId, id, startX: event.clientX, startY: event.clientY, origin: offsets[id] ?? { dx: 0, dy: 0 }, moved: false };
    stage.current.setPointerCapture(event.pointerId);
  }

  function onStagePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    if (current.type === "pan") {
      setView({ ...current.view, x: current.view.x + dx, y: current.view.y + dy });
      return;
    }
    if (!current.moved && Math.hypot(dx, dy) < 4) return;
    current.moved = true;
    setOffsets((value) => ({ ...value, [current.id]: { dx: current.origin.dx + dx / view.scale, dy: current.origin.dy + dy / view.scale } }));
  }

  function onStagePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    drag.current = null;
    if (current.type === "node" && !current.moved) { setSelected(current.id); setTab("step"); }
  }

  // Carrying an API from the library: dropped on a step it replaces that step; anywhere else on the canvas it is added.
  function libraryApi(id: string) {
    return library?.find((api) => api.id === id) ?? null;
  }

  function targetAt(x: number, y: number): number | "canvas" | null {
    const element = document.elementFromPoint(x, y);
    if (!element || !stage.current?.contains(element)) return null;
    const step = element.closest("[data-step-index]")?.getAttribute("data-step-index");
    return step == null ? "canvas" : Number(step);
  }

  function onLibraryPointerDown(event: ReactPointerEvent<HTMLLIElement>, api: LibraryApi) {
    if (event.button !== 0 || (event.target as Element).closest("button")) return;
    pick.current = { api, pointer: event.pointerId, startX: event.clientX, startY: event.clientY, moving: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onLibraryPointerMove(event: ReactPointerEvent<HTMLLIElement>) {
    const current = pick.current;
    if (!current || current.pointer !== event.pointerId) return;
    if (!current.moving && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 5) return;
    current.moving = true;
    setCarry({ api: current.api, x: event.clientX, y: event.clientY });
    setDropTarget(targetAt(event.clientX, event.clientY));
  }

  function onLibraryPointerUp(event: ReactPointerEvent<HTMLLIElement>) {
    const current = pick.current;
    if (!current || current.pointer !== event.pointerId) return;
    pick.current = null;
    setCarry(null);
    setDropTarget(null);
    if (!current.moving) return;
    const target = targetAt(event.clientX, event.clientY);
    const api = current.api;
    if (typeof target === "number") apply(replaceApi(chain, target, api), `Step ${target + 1} is now ${api.api_name}.`);
    else if (target === "canvas") apply(addApi(chain, api), `${api.api_name} was added.`);
  }

  const selectedNode = graph.nodes.find((node) => node.id === selected) ?? null;
  const selectedIndex = selectedNode ? stepIndex.get(selectedNode.id) ?? null : null;
  const checkFor = (index: number) => {
    const pair = pairs.find((item) => item.to === index);
    return pair ? { pair, check: checks[pair.key] } : null;
  };
  /** The generator's adapter steps between two API steps of the chain. */
  const adaptersBetween = (from: number, to: number) => {
    const apis = (bundle?.lambdas ?? []).filter((lambda) => lambda.api_id).sort((a, b) => a.order - b.order);
    const low = apis[from]?.order;
    const high = apis[to]?.order;
    if (low === undefined || high === undefined) return [];
    return (bundle?.lambdas ?? []).filter((lambda) => !lambda.api_id && lambda.order > low && lambda.order < high && lambda.category === "Mapping").map((lambda) => lambda.function_name);
  };
  const allChecked = pairs.length > 0 && pairs.every((pair) => checks[pair.key]?.status === "done");
  const chainStatus = allChecked && pairs.every((pair) => { const check = checks[pair.key]; return check?.status === "done" && check.verdict === "pass"; }) ? "feasible" : "needs_decision";
  const filtered = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (library ?? []).filter((api) => words.every((word) => `${api.api_name} ${api.company_name}`.toLowerCase().includes(word)));
  }, [library, query]);

  useEffect(() => { setReplacement(""); }, [selected]);

  const definitionText = bundle
    ? (definitionFormat === "json" ? `${JSON.stringify(bundle.definition, null, 2)}\n` : definitionYaml(bundle.files))
    : "";

  async function copyDefinition() {
    try {
      await navigator.clipboard.writeText(definitionText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setNotice("The definition could not be copied; select the text and copy it instead.");
    }
  }

  function nodeClass(node: CanvasNode) {
    const classes = [styles.node, styles[`kind_${node.kind}`]];
    if (node.category) classes.push(CATEGORY_CLASS[node.category]);
    if (selected === node.id) classes.push(styles.selected);
    const index = stepIndex.get(node.id);
    if (index !== undefined && dropTarget === index) classes.push(styles.dropTarget);
    const state = run?.[node.id];
    if (state) classes.push(RUN_CLASS[state]);
    return classes.join(" ");
  }

  function renderNode(node: CanvasNode) {
    const box = boxes[node.id];
    if (!box) return null;
    const index = stepIndex.get(node.id);
    const input = index !== undefined ? checkFor(index) : null;
    const check = input?.check;
    const style = { left: box.x, top: box.y, width: box.width, height: box.height };
    const common = {
      "data-node": node.id,
      className: nodeClass(node),
      style,
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => onNodePointerDown(event, node.id),
      onClick: (event: ReactMouseEvent) => { if (event.detail === 0) { setSelected(node.id); setTab("step"); } },
      "aria-pressed": selected === node.id,
      type: "button" as const,
    };
    if (node.kind === "start" || node.kind === "end") {
      return <button key={node.id} {...common} aria-label={node.label}>{node.label}</button>;
    }
    if (node.kind === "api" && node.lambda) {
      return (
        <button key={node.id} {...common} data-step-index={index} aria-label={`Step ${index! + 1}: ${node.lambda.api_name}, Lambda ${node.label}`}>
          <span className={styles.nodeMeta}>
            <span className={styles.lambdaIcon} aria-hidden="true">λ</span>
            Lambda · {CATEGORY_LABEL[node.category!]}
            {check?.status === "done" && <span className={`${styles.verdictDot} ${VERDICT_COPY[check.verdict].tone}`} title={`Input: ${VERDICT_COPY[check.verdict].label}`} />}
          </span>
          <strong>{node.label}</strong>
          <span className={styles.nodeApi}>{node.lambda.api_name}</span>
        </button>
      );
    }
    if (node.kind === "adapter") {
      return (
        <button key={node.id} {...common} aria-label={`Adapter step ${node.label}`}>
          <span className={styles.nodeMeta}><span className={styles.lambdaIcon} aria-hidden="true">λ</span>Lambda · Adapter</span>
          <strong>{node.label}</strong>
        </button>
      );
    }
    const typeLabel = node.kind === "choice" ? "Choice" : node.kind === "fail" ? "Fail" : node.kind === "succeed" ? "Succeed" : node.stateType || "State";
    return (
      <button key={node.id} {...common} aria-label={`${typeLabel} state ${node.label}`}>
        <span className={styles.nodeMeta}>{node.kind === "choice" && <span className={styles.choiceIcon} aria-hidden="true" />}{typeLabel}</span>
        <strong>{node.label}</strong>
      </button>
    );
  }

  function renderEdge(edge: CanvasEdge) {
    const from = boxes[edge.from];
    const to = boxes[edge.to];
    if (!from || !to) return null;
    const active = selected !== null && (edge.from === selected || edge.to === selected);
    const dashed = edge.kind === "default" || edge.kind === "catch";
    return (
      <path
        key={edge.id}
        d={edgePath(from, to)}
        className={`${styles.edge} ${dashed ? styles.edgeDashed : ""} ${edge.kind === "catch" ? styles.edgeError : ""} ${active ? styles.edgeActive : ""}`}
        markerEnd={active ? "url(#wf-arrow-active)" : "url(#wf-arrow)"}
      />
    );
  }

  const stageBounds = useMemo(() => {
    const all = Object.values(boxes);
    return {
      width: Math.max(400, ...all.map((box) => box.x + box.width + 120)),
      height: Math.max(300, ...all.map((box) => box.y + box.height + 120)),
    };
  }, [boxes]);

  const apiLambdas = bundle?.lambdas.filter((lambda) => lambda.api_id) ?? [];
  // The SAM package (#136) carries template.yaml beside the definition; the first packages did not.
  const isSamPackage = bundle?.files.some((file) => /(^|\/)template\.yaml$/.test(file.path)) ?? false;
  const stateCount = Object.keys(bundle?.definition.States ?? {}).length;
  const stateNames = useMemo(() => Object.keys(bundle?.definition.States ?? {}), [bundle]);

  // Readiness: what stands between this workflow and a run on AWS, in the order it is met.
  const readiness: Readiness[] = (() => {
    if (!chainKey) return [];
    const items: Readiness[] = [];
    const problems = chainProblems(chain);
    items.push(problems.length
      ? { label: "Steps", state: "blocked", text: problems[0], tab: "step" }
      : generation.status === "error" ? { label: "Steps", state: "blocked", text: generation.message, tab: "step" }
      : { label: "Steps", state: generation.status === "ready" ? "ready" : "waiting", text: `${chain.length} API step${chain.length === 1 ? "" : "s"} in the client's order: transform, validate, send.`, tab: "step" });
    if (pairs.length) {
      const done = pairs.map((pair) => checks[pair.key]).filter((check): check is Extract<Check, { status: "done" }> => check?.status === "done");
      const passed = done.filter((check) => check.verdict === "pass").length;
      const failed = pairs.filter((pair) => { const check = checks[pair.key]; return check?.status === "absent" || (check?.status === "done" && check.verdict === "fail"); }).length;
      items.push(done.length < pairs.length && failed === 0
        ? { label: "Connections", state: "waiting", text: "Checking each connection…", tab: "checks" }
        : { label: "Connections", state: failed ? "blocked" : passed === pairs.length ? "ready" : "check", text: `${passed} of ${pairs.length} compatible${failed ? `, ${failed} not` : ""}${pairs.length - passed - failed ? `, ${pairs.length - passed - failed} waiting for a decision` : ""}.`, tab: "checks" });
    }
    const parameters = bundle?.parameters ?? [];
    // Deployed from the site, the server fills in the hidden ones and its own settings (the Mailgun domain,
    // the B2Brouter account); from the ZIP, whoever deploys it sets those too.
    const byServer = (parameter: DeployParameterView) => parameter.no_echo || (canDeploy && SERVER_FILLED.has(parameter.name));
    const toFill = parameters.filter((parameter) => !byServer(parameter) && !parameter.default);
    const hiddenCount = parameters.filter(byServer).length;
    items.push({
      label: "Inputs", state: toFill.length ? "check" : "ready", tab: "export",
      text: parameters.length === 0 ? "No deploy-time values are needed."
        : `${parameters.length} deploy parameter${parameters.length === 1 ? "" : "s"}${toFill.length ? `; ${toFill.map((parameter) => parameter.name).join(", ")} must be filled in` : "; all have a value"}${hiddenCount ? `; ${hiddenCount} filled in by the server` : ""}.`,
    });
    const secrets = bundle?.secrets ?? [];
    items.push({ label: "Credentials", state: secrets.length ? "check" : "ready", tab: "export", text: secrets.length ? `Read from AWS Secrets Manager: ${secrets.map((secret) => secret.name).join(", ")}. An administrator creates them once (README step 3).` : "No API in this workflow needs a credential." });
    if (bundle?.warnings.length) items.push({ label: "Warnings", state: "check", text: bundle.warnings.join(" "), tab: "step" });
    items.push(deployView.status === "deployment"
      ? { label: "AWS", state: deployView.deployment.status === "succeeded" ? "ready" : deployView.deployment.status === "failed" ? "blocked" : "waiting", tab: "export", text: deployView.deployment.status === "succeeded" ? "Deployed; it can be run from the Export tab." : deployView.deployment.status === "failed" ? `The last deployment failed${deployView.deployment.error ? `: ${deployView.deployment.error.message}` : "."}` : deployView.deployment.phase === "deleting" ? "Being deleted…" : "Being deployed…" }
      : { label: "AWS", state: "check", tab: "export", text: deployView.status === "unavailable" ? "Download the ZIP and deploy it with its README; deploying from the site is not set up on this server yet." : canDeploy ? "Not deployed yet." : "Download the ZIP and deploy it with its README; administrators can also deploy from the site." });
    return items;
  })();

  return (
    <main className={styles.page} id="main-content">
      <section className={styles.hero} aria-labelledby="canvas-title">
        <div>
          <p className="eyebrow">Workflow canvas</p>
          <h1 id="canvas-title">Design the workflow AWS will run.</h1>
          <p>Drag APIs from the library onto the canvas, drop one on a step to replace it, and move the steps to read the flow your way. After every change the Step Functions generator builds the workflow again, so the diagram is the state machine AWS Step Functions will show.</p>
        </div>
        <a className="button secondary" href="/workflows/create">Find a chain first</a>
      </section>

      <div className={styles.workspace}>
        <aside className={styles.library} aria-labelledby="library-title">
          <div className={styles.panelHeading}>
            <h2 id="library-title">API library</h2>
            <p>Drag an API onto the canvas, or use Add.</p>
          </div>
          <label className={styles.search}>
            <span className="sr-only">Search the API library</span>
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search APIs or providers" />
          </label>
          {libraryError && <p className={styles.error} role="alert">{libraryError}</p>}
          {!library && !libraryError && <p className={styles.muted} role="status">Loading the library…</p>}
          {library && (
            <div className={styles.libraryGroups}>
              {STEP_CATEGORIES.map((category) => {
                const items = filtered.filter((api) => api.category === category);
                return (
                  <section key={category} className={`${styles.libraryGroup} ${CATEGORY_CLASS[category]}`}>
                    <h3><span className={styles.categoryDot} aria-hidden="true" />{category}<span>{items.length}</span></h3>
                    {items.length === 0 ? <p className={styles.muted}>No API matches.</p> : (
                      <ul>
                        {items.map((api) => {
                          const used = chain.some((item) => item.id === api.id);
                          return (
                            <li
                              key={api.id}
                              onPointerDown={(event) => onLibraryPointerDown(event, api)}
                              onPointerMove={onLibraryPointerMove}
                              onPointerUp={onLibraryPointerUp}
                              onPointerCancel={() => { pick.current = null; setCarry(null); setDropTarget(null); }}
                              className={used ? styles.inUse : undefined}
                            >
                              <span className={styles.libraryText}>
                                <strong>{api.api_name}</strong>
                                <small>{api.company_name}{api.verified ? " · Verified" : ""}{used ? " · In this workflow" : ""}</small>
                              </span>
                              <button type="button" className={styles.addButton} onClick={() => apply(addApi(chain, api), `${api.api_name} was added.`)} aria-label={`Add ${api.api_name}`}>Add</button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </aside>

        <section className={styles.canvasColumn} aria-label="Workflow diagram">
          <div className={styles.toolbar}>
            <div className={styles.toolGroup}>
              <button type="button" className="button secondary" onClick={undo} disabled={!history.past.length}>Undo</button>
              <button type="button" className="button secondary" onClick={redo} disabled={!history.future.length}>Redo</button>
            </div>
            <div className={styles.toolGroup}>
              <button type="button" className="button secondary" onClick={() => zoom(1 / 1.2)} aria-label="Zoom out">−</button>
              <span className={styles.zoomValue} aria-live="polite">{Math.round(view.scale * 100)}%</span>
              <button type="button" className="button secondary" onClick={() => zoom(1.2)} aria-label="Zoom in">+</button>
              <button type="button" className="button secondary" onClick={fit}>Fit</button>
              <button type="button" className="button secondary" onClick={() => { setOffsets({}); fittedFor.current = ""; }} disabled={!Object.keys(offsets).length}>Tidy layout</button>
            </div>
            <p className={styles.status} role="status">
              {!chainKey ? "No steps yet"
                : generation.status === "loading" ? "Building the workflow…"
                : generation.status === "error" ? "Not updated"
                : `${chain.length} API step${chain.length === 1 ? "" : "s"} · ${stateCount} states`}
            </p>
          </div>
          {notice && (
            <div className={styles.notice} role="status">
              <p>{notice}</p>
              <button type="button" className={styles.textButton} onClick={() => setNotice("")}>Dismiss</button>
            </div>
          )}
          {generation.status === "error" && <p className={styles.error} role="alert">{generation.message}</p>}
          {run && (
            <div className={styles.notice} role="status">
              <p>Showing the AWS run: {Object.values(run).filter((state) => state === "succeeded").length} states succeeded{Object.values(run).includes("failed") ? ", one failed" : ""}{Object.values(run).includes("running") ? ", one running" : ""}.</p>
              <button type="button" className={styles.textButton} onClick={() => setRun(null)}>Clear</button>
            </div>
          )}
          <div
            ref={stage}
            className={`${styles.stage} ${dropTarget === "canvas" ? styles.stageDrop : ""} ${stale ? styles.stale : ""}`}
            onPointerDown={onStagePointerDown}
            onPointerMove={onStagePointerMove}
            onPointerUp={onStagePointerUp}
            onPointerCancel={() => { drag.current = null; }}
          >
            <div className={styles.layer} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
              <svg className={styles.edges} width={stageBounds.width} height={stageBounds.height} aria-hidden="true">
                <defs>
                  <marker id="wf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" className={styles.arrow} />
                  </marker>
                  <marker id="wf-arrow-active" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" className={styles.arrowActive} />
                  </marker>
                </defs>
                {graph.edges.map(renderEdge)}
              </svg>
              {graph.edges.filter((edge) => edge.label).map((edge) => {
                const from = boxes[edge.from];
                const to = boxes[edge.to];
                if (!from || !to) return null;
                const point = edgeMidpoint(from, to);
                return <span key={`label-${edge.id}`} className={`${styles.edgeLabel} ${edge.kind === "choice" ? styles.edgeLabelPass : ""}`} style={{ left: point.x, top: point.y }}>{edge.label}</span>;
              })}
              {graph.nodes.map(renderNode)}
            </div>
            {!chainKey && library && (
              <div className={styles.emptyHint}>
                <strong>Drag an API here to start.</strong>
                <span>Or choose a chain in Create a workflow and open it on the canvas.</span>
              </div>
            )}
            <p className={styles.stageHelp}>Drag the background to pan · Ctrl or ⌘ + scroll to zoom</p>
          </div>
        </section>

        <aside className={styles.inspector} aria-label="Workflow details">
          <div className={styles.tabs} role="tablist" aria-label="Workflow details">
            {([["step", "Step"], ["checks", "Connections"], ["readiness", "Readiness"], ["definition", "Definition"], ["export", "Export"]] as const).map(([value, label]) => (
              <button key={value} type="button" role="tab" aria-selected={tab === value} className={tab === value ? styles.tabActive : undefined} onClick={() => setTab(value)}>{label}</button>
            ))}
          </div>

          {tab === "step" && (
            <div className={styles.tabBody}>
              {!selectedNode && (
                <>
                  <h2>{bundle?.name ?? (name || "New workflow")}</h2>
                  <p className={styles.muted}>Select a state on the canvas to see its details. API steps can be replaced, moved or removed.</p>
                  {chain.length > 0 && (
                    <ol className={styles.stepList}>
                      {chain.map((api, index) => {
                        const node = graph.nodes.find((item) => stepIndex.get(item.id) === index);
                        return (
                          <li key={`${api.id}-${index}`} className={CATEGORY_CLASS[api.category]}>
                            <button type="button" onClick={() => node && setSelected(node.id)} disabled={!node}>
                              <span>{index + 1} · {CATEGORY_LABEL[api.category]}</span>
                              <strong>{api.api_name}</strong>
                            </button>
                          </li>
                        );
                      })}
                    </ol>
                  )}
                  {bundle && bundle.warnings.length > 0 && (
                    <section className={styles.callout}>
                      <h3>Before deploying</h3>
                      <ul>{bundle.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
                    </section>
                  )}
                </>
              )}

              {selectedNode?.kind === "api" && selectedNode.lambda && selectedIndex !== null && (() => {
                const lambda = selectedNode.lambda;
                const api = chain[selectedIndex];
                const input = checkFor(selectedIndex);
                const options = (library ?? []).filter((item) => item.category === api?.category && item.id !== api?.id);
                return (
                  <>
                    <p className={`${styles.chip} ${CATEGORY_CLASS[selectedNode.category!]}`}>Step {selectedIndex + 1} · {selectedNode.category}</p>
                    <h2>{lambda.api_name}</h2>
                    <p className={styles.muted}>{lambda.company_name} · <a href={`/apis?api=${encodeURIComponent(lambda.api_id!)}`} target="_blank" rel="noopener noreferrer">Open in the API library ↗</a></p>
                    <dl className={styles.facts}>
                      <div><dt>Lambda function</dt><dd><code>{lambda.function_name}</code></dd></div>
                      <div><dt>Runtime</dt><dd>{lambda.runtime} · {lambda.handler} · {lambda.timeout_seconds} s</dd></div>
                    </dl>
                    <h3>Environment</h3>
                    <dl className={styles.facts}>
                      {Object.entries(lambda.environment).map(([key, value]) => (
                        <div key={key}><dt><code>{key}</code></dt><dd>{value ? <code className={styles.wrap}>{value}</code> : <span className={styles.muted}>Set when deploying</span>}</dd></div>
                      ))}
                    </dl>
                    {bundle && lambda.call && (
                      <>
                        <h3>Request inputs</h3>
                        <ul className={styles.inputList}>
                          {stepInputs(lambda, bundle.definition, selectedNode.id).map((row) => (
                            <li key={`${row.field}-${row.source}`} className={styles[`source_${row.source}`]}>
                              <code>{row.field}</code>
                              <span className={styles.sourceTag}>{SOURCE_LABEL[row.source]}</span>
                              <small>{row.detail}</small>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                    {input && (
                      <section className={styles.callout}>
                        <h3>Input from step {input.pair.from + 1}</h3>
                        <CheckLine check={input.check} adapters={adaptersBetween(input.pair.from, input.pair.to)} />
                      </section>
                    )}
                    {lambda.setup.length > 0 && <><h3>Setup</h3><ul className={styles.setup}>{lambda.setup.map((line) => <li key={line}>{line}</li>)}</ul></>}
                    <h3>Change this step</h3>
                    <div className={styles.replace}>
                      <label>
                        <span className="sr-only">Replace with</span>
                        <select value={replacement} onChange={(event) => setReplacement(event.target.value)}>
                          <option value="">Replace with another {api?.category.toLowerCase()} API…</option>
                          {options.map((item) => <option key={item.id} value={item.id}>{item.api_name}</option>)}
                        </select>
                      </label>
                      <button type="button" className="button primary" disabled={!replacement} onClick={() => { const next = libraryApi(replacement); if (next) apply(replaceApi(chain, selectedIndex, next), `Step ${selectedIndex + 1} is now ${next.api_name}.`); }}>Replace</button>
                    </div>
                    <div className={styles.stepActions}>
                      <button type="button" className="button secondary" disabled={selectedIndex === 0} onClick={() => apply(moveApi(chain, selectedIndex, -1))}>Move earlier</button>
                      <button type="button" className="button secondary" disabled={selectedIndex === chain.length - 1} onClick={() => apply(moveApi(chain, selectedIndex, 1))}>Move later</button>
                      <button type="button" className={`button secondary ${styles.danger}`} onClick={() => apply(removeApi(chain, selectedIndex), `${api?.api_name ?? "The step"} was removed.`)}>Remove step</button>
                    </div>
                  </>
                );
              })()}

              {selectedNode?.kind === "adapter" && selectedNode.lambda && (
                <>
                  <p className={`${styles.chip} ${styles.adapterChip}`}>Adapter</p>
                  <h2>{selectedNode.label}</h2>
                  <p>{selectedNode.lambda.api_name}.</p>
                  <p className={styles.muted}>The generator adds this step because the APIs on either side do not fit as they are. It is drawn because it runs as its own Lambda function.</p>
                  <dl className={styles.facts}>
                    <div><dt>Runtime</dt><dd>{selectedNode.lambda.runtime} · {selectedNode.lambda.handler} · {selectedNode.lambda.timeout_seconds} s</dd></div>
                  </dl>
                  {selectedNode.lambda.setup.length > 0 && <ul className={styles.setup}>{selectedNode.lambda.setup.map((line) => <li key={line}>{line}</li>)}</ul>}
                </>
              )}

              {selectedNode?.kind === "choice" && selectedNode.state && (
                <>
                  <p className={styles.chip}>Choice state</p>
                  <h2>{selectedNode.label}</h2>
                  <ul className={styles.setup}>
                    {(Array.isArray(selectedNode.state.Choices) ? selectedNode.state.Choices : []).map((rule, index) => (
                      <li key={index}>If <strong>{choiceLabel(rule)}</strong>, go to <code>{typeof rule === "object" && rule && !Array.isArray(rule) ? String(rule.Next) : ""}</code>.</li>
                    ))}
                    {typeof selectedNode.state.Default === "string" && <li>Otherwise go to <code>{selectedNode.state.Default}</code>.</li>}
                  </ul>
                </>
              )}

              {(selectedNode?.kind === "fail" || selectedNode?.kind === "succeed" || selectedNode?.kind === "pass" || selectedNode?.kind === "state") && selectedNode.state && (
                <>
                  <p className={styles.chip}>{selectedNode.stateType} state</p>
                  <h2>{selectedNode.label}</h2>
                  {selectedNode.kind === "fail" ? (
                    <dl className={styles.facts}>
                      <div><dt>Error</dt><dd><code>{String(selectedNode.state.Error ?? "")}</code></dd></div>
                      <div><dt>Cause</dt><dd>{String(selectedNode.state.Cause ?? "")}</dd></div>
                    </dl>
                  ) : <p className={styles.muted}>Added by the generator.</p>}
                </>
              )}

              {(selectedNode?.kind === "start" || selectedNode?.kind === "end") && (
                <>
                  <h2>{selectedNode.label}</h2>
                  <p className={styles.muted}>{selectedNode.kind === "start" ? "Where an execution begins. Its input is the document the first step reads." : "Where an execution ends, after delivery or a failure."}</p>
                </>
              )}
            </div>
          )}

          {tab === "checks" && (
            <div className={styles.tabBody}>
              <h2>Connections</h2>
              <p className={styles.muted}>Each step is checked against the step whose document it receives, by the same engine as Create a workflow. A validator passes the document on unchanged, so the sender is checked against the last transformation.</p>
              {assessment?.status === "done" && assessment.absent && <p className={styles.error}>{assessment.absent}</p>}
              {pairs.length === 0 ? <p className={styles.muted}>Add at least two steps to check a connection.</p> : (
                <ol className={styles.checkList}>
                  {pairs.map((pair) => (
                    <li key={pair.key}>
                      <strong>{pair.from + 1} → {pair.to + 1}</strong>
                      <span>{chain[pair.from].api_name} → {chain[pair.to].api_name}</span>
                      <CheckLine check={checks[pair.key]} adapters={adaptersBetween(pair.from, pair.to)} />
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}

          {tab === "readiness" && (
            <div className={styles.tabBody}>
              <h2>Readiness</h2>
              <p className={styles.muted}>What this workflow needs before it runs on AWS, checked as you edit.</p>
              {readiness.length === 0 ? <p className={styles.muted}>Add a step to see what the workflow needs.</p> : (
                <ol className={styles.readiness}>
                  {readiness.map((item) => (
                    <li key={item.label}>
                      <span className={`${styles.verdict} ${item.state === "ready" ? styles.pass : item.state === "blocked" ? styles.fail : styles.pending}`}>{READINESS_LABEL[item.state]}</span>
                      <strong>{item.label}</strong>
                      <span>{item.text}</span>
                      {item.tab && item.tab !== "readiness" && <button type="button" className={styles.textButton} onClick={() => setTab(item.tab!)}>Open {item.tab === "checks" ? "Connections" : item.tab[0].toUpperCase() + item.tab.slice(1)}</button>}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}

          {tab === "definition" && (
            <div className={styles.tabBody}>
              <div className={styles.definitionHeading}>
                <h2>State machine definition</h2>
                <div className={styles.segmented} role="group" aria-label="Definition format">
                  <button type="button" aria-pressed={definitionFormat === "yaml"} onClick={() => setDefinitionFormat("yaml")}>YAML</button>
                  <button type="button" aria-pressed={definitionFormat === "json"} onClick={() => setDefinitionFormat("json")}>JSON</button>
                </div>
              </div>
              {bundle && chainKey ? (
                <>
                  <p className={styles.muted}>The Amazon States Language the canvas draws. {stale ? "It is being rebuilt for your last change." : "It follows every change."}</p>
                  <pre className={styles.code}><code>{definitionText}</code></pre>
                  <button type="button" className="button secondary" onClick={() => void copyDefinition()}>{copied ? "Copied" : `Copy ${definitionFormat.toUpperCase()}`}</button>
                </>
              ) : <p className={styles.muted}>Add a step to see the definition.</p>}
            </div>
          )}

          {tab === "export" && (
            <div className={styles.tabBody}>
              <h2>Export</h2>
              <label className={styles.field}>
                <span>Workflow name</span>
                <input value={name} maxLength={80} onChange={(event) => setName(event.target.value.replace(/[^A-Za-z0-9_-]/g, ""))} placeholder={bundle?.name ?? "BP-Upbrains-AmitTransform-ESS-Mailgun"} />
                <small>Letters, digits, - and _. It names the state machine and the files; left empty, the workflow is named after its companies.</small>
              </label>
              <section className={styles.callout}>
                <h3>Download for AWS</h3>
                <p>{isSamPackage ? <>A ZIP that one <code>sam deploy</code> in AWS CloudShell turns into this state machine: template.yaml, the definition in JSON and YAML, one Lambda function per step (</> : "A ZIP with the definition in JSON and YAML, one Lambda function per step ("}{apiLambdas.length} API{apiLambdas.length === 1 ? "" : "s"}{bundle && bundle.lambdas.length > apiLambdas.length ? `, ${bundle.lambdas.length - apiLambdas.length} adapter${bundle.lambdas.length - apiLambdas.length === 1 ? "" : "s"}` : ""}) and {isSamPackage ? "a README with the steps" : "setup instructions"}.</p>
                {chainKey ? <GenerateWorkflowButton chain={{ api_ids: chain.map((api) => api.id), status: chainStatus }} name={name || undefined} />
                  : <button type="button" className="button secondary" disabled>Generate workflow</button>}
              </section>
              <DeployPanel
                chainIds={chain.map((api) => api.id)}
                chainStatus={chainStatus}
                name={name || undefined}
                bundle={bundle && chainKey ? bundle : null}
                stale={stale}
                canDeploy={canDeploy}
                accountEmail={accountEmail}
                stateNames={stateNames}
                onRunStates={onRunStates}
                onView={setDeployView}
              />
            </div>
          )}
        </aside>
      </div>
      {carry && (
        <div className={styles.carry} style={{ left: carry.x, top: carry.y }} aria-hidden="true">
          <strong>{carry.api.api_name}</strong>
          <span>{typeof dropTarget === "number" ? `Replace step ${dropTarget + 1}` : dropTarget === "canvas" ? "Add to the workflow" : "Drop on the canvas"}</span>
        </div>
      )}
    </main>
  );
}

function CheckLine({ check, adapters = [] }: { check: Check | undefined; adapters?: string[] }) {
  if (!check || check.status === "loading") return <p className={styles.muted}>Checking…</p>;
  if (check.status === "error") return <p className={styles.muted}>The check could not be run.</p>;
  if (check.status === "absent") return <p className={styles.checkLine}><span className={`${styles.verdict} ${styles.fail}`}>Not offered</span><span>{check.reason}</span></p>;
  const copy = VERDICT_COPY[check.verdict];
  return (
    <p className={styles.checkLine}>
      <span className={`${styles.verdict} ${copy.tone}`}>{copy.label}</span>
      {adapters.length > 0 && <span>The generated workflow runs {adapters.join(" and ")} on this connection.</span>}
      <span>{copy.detail}{check.blocking.length ? ` Held at ${check.blocking.map((name) => name.replace(/^check\s*/i, "Check ")).join(", ")}.` : ""}</span>
    </p>
  );
}
