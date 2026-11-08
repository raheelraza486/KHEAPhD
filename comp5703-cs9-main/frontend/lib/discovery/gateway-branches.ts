import type { DiscoveryProcessJson } from "./types.ts";

type DiscoveryStep = DiscoveryProcessJson["steps"][number];

const EMAIL = /\be[\s-]?mail\b/i;
const PEPPOL = /\bpeppol\b/i;
const SEND = /\b(?:send|submit|transmit|deliver|dispatch|email)\b/i;
const RECEIVE = /\b(?:receive|retrieve|fetch|download)\b/i;

function deliveryChannel(step: DiscoveryStep): "email" | "peppol" | null {
  if (step.category !== "Communication" || RECEIVE.test(step.task) || !SEND.test(step.task)) return null;
  const email = EMAIL.test(step.task);
  const peppol = PEPPOL.test(step.task);
  if (email === peppol) return null;
  return email ? "email" : "peppol";
}

function sharedName(left: string | null, right: string | null): string | null {
  if (!left || !right) return null;
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0 ? left : null;
}

function mergeDeliveryAlternatives(left: DiscoveryStep, right: DiscoveryStep): DiscoveryStep | null {
  const channels = new Set([deliveryChannel(left), deliveryChannel(right)]);
  if (!channels.has("email") || !channels.has("peppol")) return null;
  return {
    ...left,
    task: "send via email or Peppol",
    input_format: sharedName(left.input_format, right.input_format),
    output_format: sharedName(left.output_format, right.output_format),
    rule_set: sharedName(left.rule_set, right.rule_set),
    candidate_ids: null,
  };
}

const ALTERNATIVE_CHANNELS = /\b(?:e[\s-]?mail\s+or\s+(?:(?:by|via|over|through)\s+)?peppol|peppol\s+or\s+(?:(?:by|via|over|through)\s+)?e[\s-]?mail)\b/i;

/**
 * A gateway drawn as two boxes can come back as one send step that keeps only
 * one box's label ("Send via email"), because grounding cites one box. When the
 * recognised flow states the channels as alternatives and that is the only
 * send step, it stands for both branches. The same applies when the one step
 * joins both box labels without "or" ("Send via email Send via Peppol"), which
 * the candidate search would otherwise read as two required channels.
 */
function widenSingleDeliveryStep(steps: DiscoveryStep[]): DiscoveryStep[] {
  const sends = steps.filter(step => step.category === "Communication" && SEND.test(step.task) && !RECEIVE.test(step.task));
  if (sends.length !== 1) return steps;
  const task = sends[0].task;
  const joinedLabels = EMAIL.test(task) && PEPPOL.test(task) && !ALTERNATIVE_CHANNELS.test(task);
  if (deliveryChannel(sends[0]) === null && !joinedLabels) return steps;
  // Another channel-labelled communication step may be a separate receive or
  // archive action, rather than a dropped delivery branch.
  if (steps.some(step => step !== sends[0] && step.category === "Communication"
    && (EMAIL.test(step.task) || PEPPOL.test(step.task)))) return steps;
  return steps.map(step => step === sends[0]
    ? { ...step, task: "send via email or Peppol", candidate_ids: null }
    : step);
}

/**
 * Gemini normally follows the BPMN gateway rule in the prompt. This boundary is
 * deliberately narrower: the recognised flow must describe email and Peppol
 * as alternatives. Adjacent branches are merged, or a sole channel-labelled
 * sending step recovers the other branch lost during grounding. Proximity alone
 * cannot distinguish a gateway from sequential sends. Text and audio inputs
 * never use this normaliser.
 */
export function collapseBpmnDeliveryBranches(process: DiscoveryProcessJson): DiscoveryProcessJson {
  if (!ALTERNATIVE_CHANNELS.test(process.input_text)) return process;
  const steps: DiscoveryStep[] = [];
  for (let index = 0; index < process.steps.length; index += 1) {
    const current = process.steps[index];
    const next = process.steps[index + 1];
    const merged = next ? mergeDeliveryAlternatives(current, next) : null;
    steps.push({ ...(merged ?? current), order: steps.length + 1 });
    if (merged) index += 1;
  }
  return { ...process, steps: widenSingleDeliveryStep(steps) };
}
