import type { DiscoveryInput } from "./types.ts";
import { canonicalDiscoveryFormat } from "./normalize.ts";

export type DiscoveryReview = { order?: number; message: string };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown) => typeof value === "string" ? value.normalize("NFKC").replace(/\s+/g, " ").trim() : "";
const contains = (source: string, quote: string) => !!quote && source.toLowerCase().includes(quote.toLowerCase());
const actionPatterns = [
  { category: "Transformation", pattern: /\b(?:convert(?:ed|ing)?|extract(?:ed|ing)?|creat(?:e|ed|ing)|generat(?:e|ed|ing)|transform(?:ed|ing)?)\b|转换|提取|生成/i },
  { category: "Validation", pattern: /\b(?:validat(?:e|ed|ing)|check(?:ed|ing)?|verif(?:y|ied|ying))\b|校验|验证/i },
  { category: "Communication", pattern: /\b(?:send(?:ing)?|sent|deliver(?:ed|ing)?|transmit(?:ted|ting)?)\b|发送|传送/i },
];
function sourceClauses(source: string): { category: string; quote: string }[] {
  return source.split(/[,;；\n]|\.(?=\s|$)/).flatMap(clause => {
    const markers = actionPatterns.flatMap(({ category, pattern }) => [...clause.matchAll(new RegExp(pattern.source, "ig"))].map(match => ({ category, index: match.index! }))).sort((a, b) => a.index - b.index);
    return markers.map((marker, index) => ({ category: marker.category,
      quote: clause.slice(index === 0 ? 0 : marker.index, markers[index + 1]?.index)
        .replace(/(?:\s+\b(?:and|then|is|are)\b)+\s*$/i, "").trim() }));
  });
}
function deliveryChannel(source: string): string | null {
  const match = /\b(?:via|over|through|by)\s+(?:the\s+)?(e-?mail|peppol)(?:\s+(?:network\s+)?or\s+(?:(?:via|over|through|by)\s+)?(e-?mail|peppol))?\b|(?:通过|经由)(邮件|电子邮件|Peppol)/i.exec(source);
  if (!match) return null;
  const channel = (value: string) => /peppol/i.test(value) ? "Peppol" : "email";
  return match[2] ? `${channel(match[1])} or ${channel(match[2])}` : channel(match[1] ?? match[3]);
}
function explicitGoalFormats(source: string): { input?: string; output?: string } {
  const format = "((?:XML[ _/-]+UBL|UBL[ _/-]+XML|UBL|PDF|JSON|XML|CII|CSV)(?:\\s+v?\\d+(?:\\.\\d+)*)?)\\b";
  const input = new RegExp(`(?:\\binput\\s+(?:(?:is|comes)\\s+)?(?:in\\s+)?|\\bsupplier\\s+(?:sends?\\s+)?|输入(?:为|是|格式为|格式是)?\\s*)${format}`, "i").exec(source);
  const output = new RegExp(`(?:\\b(?:sent|send|delivered|deliver)\\s+(?:(?:it|an?|the|invoice|in)\\s+)*|\\boutput\\s+(?:is\\s+)?(?:in\\s+)?|\\bcustomer\\s+(?:needs?|requires?)\\s+|输出(?:为|是|格式为|格式是)?\\s*)${format}`, "i").exec(source);
  return { ...(input ? { input: String(canonicalDiscoveryFormat(input[1])) } : {}), ...(output ? { output: String(canonicalDiscoveryFormat(output[1])) } : {}) };
}
const responseWords = /\b(return\w*|response|report|receipt|acknowledg\w*|output|status)\b|返回|输出|报告|回执/i;
function labelIn(source: string, quote: string): boolean {
  source = source.toLowerCase(); quote = quote.toLowerCase();
  let start = source.indexOf(quote);
  while (quote && start >= 0) {
    if (!/[A-Za-z0-9_]/.test(source[start - 1] ?? "") && !/[A-Za-z0-9_]/.test(source[start + quote.length] ?? "")) return true;
    start = source.indexOf(quote, start + 1);
  }
  return false;
}
function responseLabel(scope: string, label: string): boolean {
  return scope.split(/[,;]|\band\b|\bthen\b|并且|然后|并/i).some(clause => {
    const marker = /\b(?:return\w*|output|reply)\b|返回|输出/i.exec(clause);
    return marker ? labelIn(clause.slice(marker.index), label)
      : responseWords.test(clause) && !/\b(?:validate|send|deliver)\b|校验|验证|发送/i.test(clause) && labelIn(clause, label);
  });
}
function inputLabel(scope: string, label: string): boolean {
  return scope.split(/[,;]|\band\b|\bthen\b|并且|然后|并/i).some(clause => {
    const marker = /\b(?:return\w*|output|reply)\b|返回|输出/i.exec(clause);
    return labelIn(marker ? clause.slice(0, marker.index) : clause, label);
  });
}

/** Model-only evidence is stripped here, before the unchanged Process JSON contract. */
export function groundDiscoveryResult(raw: unknown, input: DiscoveryInput): { process: unknown; review: DiscoveryReview[] } {
  if (!object(raw) || !Array.isArray(raw.steps)) return { process: raw, review: [] };
  const steps = raw.steps;
  const { source_evidence, source_text, suggested_order, ...process } = raw;
  const source = text(input.mode === "text" ? input.text : input.mode === "bpmn" && input.bpmn_xml
    ? input.bpmn_xml.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    : source_text);
  const media = input.mode === "audio" || (input.mode === "bpmn" && !input.bpmn_xml);
  const review: DiscoveryReview[] = [];
  if (media) review.push({ message: "Check the extracted steps and labels against your upload. Their source text is a model transcription." });
  if (suggested_order === true) review.push({ message: "This order is suggested from your goals. Review it before continuing; an explicitly stated order must be preserved." });
  const evidence = Array.isArray(source_evidence) ? source_evidence : [];
  const clauses = sourceClauses(source);
  const goalFormats = explicitGoalFormats(source);
  const scopes = steps.map((step, index) => {
    const proof = object(evidence[index]) ? evidence[index] : {};
    // Legacy/fake replies can only ground a task that occurs verbatim in the source.
    const quote = text(proof.step_quote ?? (object(step) ? step.task : null));
    const start = source.toLowerCase().indexOf(quote.toLowerCase());
    return { proof, quote, start, valid: contains(source, quote), suggested: proof.suggested === true };
  });
  process.steps = steps.map((step, index) => {
    if (!object(step)) return step;
    const scope = scopes[index];
    const order = typeof step.order === "number" ? step.order : undefined;
    const overlap = scope.valid && scopes.some((other, otherIndex) => otherIndex !== index && other.valid
      && scope.start < other.start + other.quote.length && other.start < scope.start + scope.quote.length);
    const categorySteps = steps.filter(other => object(other) && other.category === step.category);
    const categoryClauses = clauses.filter(clause => clause.category === step.category).map(clause => clause.quote);
    const occurrence = steps.slice(0, index).filter(other => object(other) && other.category === step.category).length;
    // When repeated actions have matching counts, each model step must use its
    // corresponding source action. A valid quote from a sibling action is not
    // evidence for this step's delivery channel or format.
    const alignedClause = categoryClauses.length === categorySteps.length ? categoryClauses[occurrence] ?? null : null;
    const scoped = scope.valid && !overlap && actionPatterns.filter(({ pattern }) => pattern.test(scope.quote)).length <= 1
      && (!alignedClause || contains(alignedClause, scope.quote));
    // A model citation may be too broad, overlap another citation or differ only
    // in case. Recover explicit facts from the source's own action clauses; do
    // not turn a citation failure into a requirement for the user to retype them.
    const uniqueCategory = categorySteps.length === 1;
    const ownClauses = alignedClause ? [alignedClause] : uniqueCategory ? categoryClauses : [];
    const contexts = [...(scoped ? [scope.quote] : []), ...ownClauses];
    const suggestedConversion = step.category === "Transformation" && (scope.suggested || (uniqueCategory && !ownClauses.length && !!goalFormats.input && !!goalFormats.output));
    const proposed = { ...step };
    if (suggestedConversion && uniqueCategory && !ownClauses.length) {
      if (goalFormats.input && (step.input_format == null || typeof step.input_format === "string")) proposed.input_format = goalFormats.input;
      if (goalFormats.output && (step.output_format == null || typeof step.output_format === "string")) proposed.output_format = goalFormats.output;
    }
    const result = { ...proposed };
    if (scoped) result.task = scope.quote.slice(0, 300);
    if (suggestedConversion) review.push({ order, message: "This conversion step connects the input and delivery formats you specified. Its position is suggested." });
    else if (!scoped && !ownClauses.length) review.push({ order, message: "This step's source could not be isolated. Review its task before continuing." });
    for (const field of ["input_format", "output_format", "rule_set"] as const) {
      if (proposed[field] == null || typeof proposed[field] !== "string") continue; // Contract errors remain visible to its parser.
      const candidates = [...new Set([text(scope.proof[field]), text(proposed[field]), ...(text(proposed[field]).toLowerCase() === "ubl xml" ? ["UBL"] : [])].filter(Boolean))];
      // Only suggested conversions may bind explicitly stated goal formats across clauses.
      const goalFormat = suggestedConversion && field !== "rule_set";
      const quote = candidates.find(candidate => {
        const cited = field === "rule_set" ? candidate : canonicalDiscoveryFormat(candidate);
        const formatMatches = field === "rule_set" || text(canonicalDiscoveryFormat(proposed[field])).toLowerCase() === text(cited).toLowerCase()
          || (text(proposed[field]).toLowerCase() === "ubl xml" && candidate.toLowerCase() === "ubl");
        return formatMatches && labelIn(source, candidate) && (contexts.some(context => labelIn(context, candidate)) || goalFormat)
          && (field === "rule_set" || !/^peppol(?:\s+network)?$/i.test(candidate))
          && (field !== "input_format" || step.category === "Transformation" || contexts.some(context => inputLabel(context, candidate)))
          && (field !== "output_format" || step.category === "Transformation" || contexts.some(context => responseLabel(context, candidate)));
      });
      if (!quote) {
        result[field] = null;
        review.push({ order, message: `The ${field.replace(/_/g, " ")} was not specified for this step and can stay blank.` });
      } else {
        // Copy the cited label, not a model expansion: bare UBL remains UBL.
        result[field] = field === "rule_set" ? quote : canonicalDiscoveryFormat(quote);
      }
    }
    if (step.category === "Validation" && result.rule_set == null && uniqueCategory) {
      const labels = ownClauses.flatMap(clause => [...clause.matchAll(/\b(?:Australian|AU|AUS)\s+rules\b|澳(?:洲|大利亚)规则/gi)].map(match => match[0]));
      if (new Set(labels.map(label => label.toLowerCase())).size === 1) {
        result.rule_set = labels[0];
        for (let i = review.length - 1; i >= 0; i--) if (review[i].order === order && review[i].message.startsWith("The rule set")) review.splice(i, 1);
      }
    }
    if (step.category === "Communication" && result.input_format == null && uniqueCategory && goalFormats.output
      && ownClauses.some(clause => inputLabel(clause, goalFormats.output!))) {
      result.input_format = goalFormats.output;
      for (let i = review.length - 1; i >= 0; i--) if (review[i].order === order && review[i].message.startsWith("The input format")) review.splice(i, 1);
    }
    // Ungrounded model task wording must not smuggle cleared formats/rules into keyword search.
    if (typeof step.task === "string" && (!scoped || suggestedConversion)) {
      const channel = contexts.map(deliveryChannel).find(Boolean);
      if (step.category === "Transformation") result.task = result.input_format && result.output_format
        ? `Convert ${result.input_format} to ${result.output_format}` : ownClauses[0] ?? "Convert invoice";
      else if (step.category === "Validation") result.task = result.rule_set ? `Validate invoice using ${result.rule_set}` : ownClauses[0] ?? "Validate invoice";
      else result.task = alignedClause?.slice(0, 300) ?? (channel ? `Send invoice via ${channel}` : ownClauses.at(-1) ?? "Send invoice");
    }
    if (step.category === "Communication") {
      const channelClauses = (alignedClause ? [alignedClause] : uniqueCategory ? categoryClauses : [])
        .map(quote => ({ quote, channel: deliveryChannel(quote) })).filter(entry => entry.channel);
      const channels = new Set(channelClauses.map(entry => entry.channel));
      // A short but valid citation can omit the channel. Recover only the
      // uniquely attributable source clause; never borrow a sibling channel.
      if (channels.size === 1 && deliveryChannel(text(result.task)) !== channelClauses[0].channel) {
        result.task = channelClauses[0].quote.slice(0, 300);
      } else if (uniqueCategory && channels.size > 1) {
        review.push({ order, message: "The source names multiple delivery actions but only one step was extracted. Review the missing send step." });
      }
    }
    return result;
  });
  return { process, review };
}
