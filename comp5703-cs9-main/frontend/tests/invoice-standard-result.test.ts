import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { componentHarness } from "./helpers/component-harness.ts";
import { runStandard } from "../lib/checks/check2-standard.ts";
import type { StandardResult } from "../lib/checks/types.ts";
import { api, side } from "./checks/helpers.ts";

const View = componentHarness()("components/invoice-standard-result.tsx").default as ComponentType<{ result: StandardResult }>;
const render = (result: StandardResult) => renderToStaticMarkup(createElement(View, { result }));
const source = side(api({ invoice_standard: ["Peppol BIS Billing 3.0"] }));
const target = side(api({ invoice_standard: ["Peppol BIS Billing 3.0"] }));

test("a passing standard result displays unreviewed claims separately", () => {
  const result = runStandard({ ...source, standard_claims: [{ direction: "output", standard: "Peppol BIS Billing 3.0", status: "reported" }] }, target);
  const html = render(result);
  assert.match(html, />Compatible</);
  assert.match(html, /Standard claim review/);
  assert.match(html, /Not yet reviewed/);
  assert.match(html, /Catalogue label only/);
  assert.doesNotMatch(html, />Confirmed</);
});

test("non-voting and historical reports are never displayed as reviewed passes", () => {
  const missing = render(runStandard(side(api()), target));
  assert.match(missing, /No standard verdict/);
  assert.match(missing, /No invoice standard recorded/);
  assert.doesNotMatch(missing, />Compatible</);
  const { review: _review, ...historical } = runStandard(source, target);
  assert.match(render(historical), /Review state unavailable in this saved report/);
});

test("fillable and different-version results retain their information notices", () => {
  assert.match(render(runStandard(source, side(api({ invoice_standard: ["Peppol PINT A-NZ 1.1.3"] })))), /additional invoice information/);
  const version = render(runStandard(side(api({ invoice_standard: ["XRechnung 3.0"] })), side(api({ invoice_standard: ["XRechnung 3.0.2"] }))));
  assert.match(version, /No standard verdict/);
  assert.match(version, /recorded versions differ/);
});

test("a compatible unreviewed claim also displays the request settings required by main's Check 2.0b", () => {
  const result = runStandard({ ...source, standard_claims: [{
    direction: "output", standard: "Peppol BIS Billing 3.0", status: "reported", condition: "standard=peppol-bis; output=xml",
  }] }, target);
  const html = render(result);
  assert.match(html, />Compatible</);
  assert.match(html, /Not yet reviewed/);
  assert.match(html, /Required request settings/);
  assert.match(html, /Source \(Peppol BIS Billing 3.0/);
  assert.match(html, /standard=peppol-bis; output=xml/);
});
