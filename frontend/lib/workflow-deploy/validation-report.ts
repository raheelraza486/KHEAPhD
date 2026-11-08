/** Read only validation findings from a failed state's input; never return invoice data. */
export function validationFailureMessage(input: string | undefined): string | null {
  if (!input) return null;
  let state: unknown;
  try { state = JSON.parse(input); } catch { return null; }
  const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const root = object(state);
  if (!root) return null;
  const messages: string[] = [];
  for (const [key, value] of Object.entries(root)) {
    if (!/^validation(?:\d+)?$/.test(key)) continue;
    const validation = object(value);
    if (validation?.isValid !== false) continue;
    const report = object(validation.report);
    if (!report) continue;
    const details = object(report.details);
    const steps = details?.steps;
    const before = messages.length;
    for (const value of Array.isArray(steps) ? steps.slice(0, 20) : []) {
      const step = object(value);
      if (!step || step.status === "success") continue;
      const detail = object(step.details);
      const failures = detail?.failures;
      const findings = Array.isArray(failures) ? failures.flatMap(value => {
        const failure = object(value);
        return failure && !["warning", "info"].includes(String(failure.severity)) && typeof failure.message === "string" ? [failure.message] : [];
      }) : [];
      const errors = detail?.errors;
      const chosen = findings.length ? findings : Array.isArray(errors) ? errors.filter((error): error is string => typeof error === "string") : [];
      messages.push(...chosen.slice(0, 8).map(message => message.replace(/\s+/g, " ").trim()));
    }
    if (messages.length === before && typeof report.summary === "string") messages.push(report.summary);
  }
  const message = [...new Set(messages.filter(Boolean))].slice(0, 5).join(" ");
  return message ? message.length > 500 ? `${message.slice(0, 499)}…` : message : null;
}
