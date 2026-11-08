import { NextResponse } from "next/server";
import { runChecks } from "@/lib/checks/run";
import { loadPairInput, PairNotFound, PairSchemaNotFound } from "@/lib/checks/store";
import type { UserChoice } from "@/lib/checks/types";
import { getCurrentAppUser } from "@/lib/auth";
import { answerBody, getSupabaseConfig, isSameOrigin, publicError, readJson } from "../shared";

export const dynamic = "force-dynamic";
const MAX_CHOICES = 100;

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  if (!isSameOrigin(request)) return publicError("Cross-origin requests are not allowed.", 403, requestId);
  let body: Record<string, unknown>;
  try { body = await readJson(request); } catch { return publicError("The request body must be a JSON object.", 400, requestId); }
  const rawChoices = Array.isArray(body.choices) ? body.choices : [];
  if (rawChoices.length === 0 || rawChoices.length > MAX_CHOICES) return publicError("choices must contain between 1 and 100 field decisions.", 400, requestId);
  const parsed = rawChoices.map((choice) => answerBody(typeof choice === "object" && choice !== null && !Array.isArray(choice) ? choice as Record<string, unknown> : {}));
  const invalid = parsed.find((choice): choice is string => typeof choice === "string");
  if (invalid) return publicError(invalid, 400, requestId);
  const answers = parsed.filter((choice): choice is Exclude<typeof choice, string> => typeof choice !== "string");
  const pair = `${answers[0].source_id}|${answers[0].target_id}`;
  if (answers.some((answer) => `${answer.source_id}|${answer.target_id}` !== pair)) return publicError("All preview choices must belong to the same API pair.", 400, requestId);
  if (new Set(answers.map((answer) => answer.format ?? "")).size !== 1) return publicError("All preview choices must use the same format.", 400, requestId);
  if (new Set(answers.map((answer) => answer.target_path)).size !== answers.length) return publicError("Each target_path may appear only once in a preview.", 400, requestId);
  const schemaPair = `${answers[0].source_schema_id ?? ""}|${answers[0].target_schema_id ?? ""}`;
  if ( answers.some((answer) => `${answer.source_schema_id ?? ""}|${answer.target_schema_id ?? ""}` !== schemaPair,)) {return publicError("All preview choices must use the same schemas.", 400, requestId,);}
  const config = getSupabaseConfig();
  if (!config) return publicError("The database is not configured.", 503, requestId);
  try {
    const input = await loadPairInput(config, answers[0].source_id, answers[0].target_id, { sourceSchemaId: answers[0].source_schema_id, targetSchemaId: answers[0].target_schema_id, },);
    // A visitor previews against the check's own result: other people's saved
    // answers are not theirs to see, and not part of what they are trying out.
    const signedIn = await getCurrentAppUser(request).then((user) => user !== null).catch(() => false);
    if (!signedIn) input.choices = [];
    const format = answers[0].format;
    const baseline = runChecks({ ...input, selectedFormat: format });
    if (format && !baseline.check1.format_options.some((option) => option.selectable && option.format === format)) {
      return publicError("format is not offered for this pair.", 400, requestId);
    }
    const semantics = baseline.check2.semantics;
    if (!semantics) return publicError("This pair has no fields open for preview.", 409, requestId);
    for (const answer of answers) {
      const open = semantics.ambiguous.some((item) => item.target_path === answer.target_path) || semantics.not_found.some((item) => item.target_path === answer.target_path) || semantics.applied.some((item) => item.target_path === answer.target_path && item.state === "agreed");
      if (!open) return publicError(semantics.conflicts.some((item) => item.target_path === answer.target_path) ? "This field is awaiting an administrator and cannot be previewed." : "This field is not open for a preview decision.", 409, requestId);
      if (answer.option === "candidate") {
        const known = semantics.ambiguous.find((item) => item.target_path === answer.target_path)?.candidates.some((candidate) => candidate.source_path === answer.chosen_source_path) || semantics.not_found.find((item) => item.target_path === answer.target_path)?.suggestions.some((candidate) => candidate.source_path === answer.chosen_source_path) || semantics.mappings.some((mapping) => mapping.target_path === answer.target_path && mapping.source_path === answer.chosen_source_path) || semantics.applied.some((item) => item.target_path === answer.target_path && item.chosen_source_path === answer.chosen_source_path);
        if (!known) return publicError("chosen_source_path is not available for this field.", 400, requestId);
      }
    }
    const targetPaths = new Set(answers.map((answer) => answer.target_path));
    const savedChoices = (input.choices ?? []).filter((choice) => !targetPaths.has(choice.target_path));
    const previewChoices: UserChoice[] = answers.map((answer, index) => ({ target_path: answer.target_path, option: answer.option, chosen_source_path: answer.chosen_source_path, kind: "user", chosen_by: `preview-${index}`, chosen_at: new Date(index).toISOString() }));
    const report = runChecks({ ...input, selectedFormat: format, choices: [...savedChoices, ...previewChoices] });
    return NextResponse.json({ report, requestId, preview: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof PairNotFound) return publicError("API record not found.", 404, requestId, { missing: error.missing });
    if (error instanceof PairSchemaNotFound) {return publicError(`${error.side}_schema_id does not identify a valid ${error.side === "source" ? "response" : "request"} schema for the selected API.`, 400, requestId,);}
    return publicError("The preview could not be generated.", 502, requestId);
  }
}
