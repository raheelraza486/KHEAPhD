function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const canonicalDiscoveryFormat = (input: unknown): unknown => typeof input === "string"
  && /^(?:xml[\s_/-]+ubl|ubl[\s_/-]+xml)$/i.test(input.trim()) ? "UBL XML" : input;

/** Canonicalise diagram labels without inferring formats or changing task order. */
export function normalizeDiscoveryResult(value: unknown): unknown {
  if (!isObject(value) || !Array.isArray(value.steps)) return value;
  const format = canonicalDiscoveryFormat;
  return {
    ...value,
    steps: value.steps.map((step) => {
      if (!isObject(step)) return step;
      const output = format(step.output_format);
      // The arrow after a send task can name the delivery network. Retain
      // that requirement in the task, rather than treating it as a file type.
      const network = step.category === "Communication" && typeof output === "string"
        && /^peppol(?:\s+network)?$/i.test(output.trim())
        && typeof step.task === "string" && /\bpeppol\b/i.test(step.task);
      return {
        ...step,
        ...(Object.hasOwn(step, "input_format") ? { input_format: format(step.input_format) } : {}),
        ...(Object.hasOwn(step, "output_format") ? { output_format: network ? null : output } : {}),
      };
    }),
  };
}
