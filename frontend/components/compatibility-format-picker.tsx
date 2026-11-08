"use client";

import type { FormatOption } from "@/lib/checks/types";

/**
 * Which format the two APIs are compared in.
 *
 * A provider may publish the same operation as JSON and as XML, and the two
 * bodies need not have the same fields. Until now the page compared whichever
 * schema the database happened to return first, so the verdict could quietly
 * belong to a format the pair would never actually exchange. The choice is
 * made here instead, and the engine keeps only the schemas carrying it.
 *
 * Every format either side declares is offered, annotated rather than hidden:
 * a format the other side does not accept, or one with no stored schema, is
 * the answer to "why does this not work" and is worth seeing. Values the
 * catalogue's format list does not know are shown last and cannot be chosen.
 */
export default function CompatibilityFormatPicker({
  options,
  selected,
  disabled,
  inputInParameters,
  onChange,
}: {
  options: readonly FormatOption[];
  selected: string | null;
  disabled: boolean;
  inputInParameters: boolean;
  onChange: (format: string) => void;
}) {
  if (options.length === 0) return null;
  const current = options.find((option) => option.format === selected) ?? null;
  const usable = options.filter((option) => option.selectable);

  return (
    <section className="compat-format-picker" aria-labelledby="compat-format-label">
      <div className="compat-format-picker-copy">
        <p className="eyebrow">Exchange format</p>
        <label id="compat-format-label" htmlFor="compat-format">
          Compare the two APIs in
        </label>
        <p>{describe(current, inputInParameters)}</p>
      </div>
      <select
        id="compat-format"
        value={selected ?? ""}
        disabled={disabled || inputInParameters || usable.length === 0}
        onChange={(event) => onChange(event.target.value)}
      >
        {selected === null && <option value="">No format in common</option>}
        {options.map((option) => (
          <option key={option.format} value={option.format} disabled={!option.selectable}>
            {option.format} — {annotate(option)}
          </option>
        ))}
      </select>
    </section>
  );
}

/** The one-line reason this option is, or is not, a working choice. */
function annotate(option: FormatOption): string {
  if (!option.recognised) return "not a registered format value";
  if (!option.common) return option.in_source ? "the target does not accept it" : "the source does not produce it";
  if (!option.source_has_schema && !option.target_has_schema) return "common format, but no schema is stored on either side";
  if (!option.source_has_schema) return "common format, but no source schema is stored for it";
  if (!option.target_has_schema) return "common format, but no target schema is stored for it";
  return "common format, schemas on both sides";
}

function describe(option: FormatOption | null, inputInParameters: boolean): string {
  if (inputInParameters) {
    return "The target has no request body: its input is URL parameters, so there is no format to choose.";
  }
  if (!option) {
    return "Neither format either API declares is accepted by the other, so there is nothing to compare in.";
  }
  if (!option.source_has_schema || !option.target_has_schema) {
    return "This format is compared with whatever is stored; the side without a schema for it is reported as missing information, not as incompatible.";
  }
  return "The comparison uses the stored schema for this format on each side.";
}
