import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeApiRecord } from "../../lib/types.ts";
import { EMPTY_FILTERS, apiCountryOptions, filterApis, formatHint, operationLabel, operationSelectorNote, selectedFormats, sharesEndpointWith } from "../../lib/compatibility/selection.ts";
import { countryRegionForRecord, UNSPECIFIED_COUNTRY_REGION } from "../../lib/country-region.ts";

test("selected schema format takes precedence over the API's aggregate formats", () => {
  const formats = selectedFormats("published", "application/xml", ["JSON", "XML"]);
  assert.deepEqual(formats, ["application/xml"]);
  assert.equal(formatHint(["JSON"], formats).status, "incompatible");
});

test("local schema files with no wire format do not inherit unrelated catalogue formats", () => {
  assert.deepEqual(selectedFormats("upload", undefined, ["JSON"]), []);
  assert.equal(formatHint(["JSON"], []).status, "unknown");
  assert.equal(formatHint(["JSON"], ["Validation Report"]).status, "unknown");
});

test("country/category/search filters intersect without excluding unknown countries from All", () => {
  const apis = [
    normalizeApiRecord({ id: "a", api_name: "Invoice validation", company_name: "Supplier A", country_region: "Australia", category: "Validation" }),
    normalizeApiRecord({ id: "b", api_name: "Invoice delivery", company_name: "Supplier B", country_region: "Australia", category: "Communication" }),
    normalizeApiRecord({ id: "c", api_name: "Invoice validation", company_name: "Supplier C", category: "Validation" }),
  ];
  assert.equal(filterApis(apis, EMPTY_FILTERS).length, 3);
  assert.deepEqual(filterApis(apis, { search: "supplier a", country: "Australia", category: "Validation" }).map((api) => api.id), ["a"]);
  assert.deepEqual(filterApis(apis, { ...EMPTY_FILTERS, country: "__unknown__" }).map((api) => api.id), ["c"]);
});

test("Compare offers and matches the same legacy country labels as the existing catalogue", () => {
  const apis = [
    normalizeApiRecord({ id: "nav", api_name: "Hungary NAV Online Invoice API" }),
    normalizeApiRecord({ id: "domain", api_name: "Invoice API", documentation_url: "https://docs.example.gov.au/api" }),
    normalizeApiRecord({ id: "explicit", api_name: "Hungary invoice service", country_region: "Germany" }),
    normalizeApiRecord({ id: "unknown", api_name: "Example API", documentation_url: "https://example.test/api" }),
  ];
  assert.deepEqual(apiCountryOptions(apis), ["Australia", "Germany", "Hungary", UNSPECIFIED_COUNTRY_REGION]);
  for (const api of apis) {
    const displayedCountry = countryRegionForRecord(api);
    assert.ok(filterApis(apis, { ...EMPTY_FILTERS, country: displayedCountry }).includes(api));
  }
  assert.deepEqual(filterApis(apis, { ...EMPTY_FILTERS, country: "Hungary" }).map((api) => api.id), ["nav"]);
  assert.equal(apis[0].country_region, "", "display fallback must not overwrite the stored field");
});

test("Compare country filters include individual regions and aliases from multi-region records", () => {
  const apis = [normalizeApiRecord({ id: "multi", country_region: "UK / global" })];
  assert.ok(apiCountryOptions(apis).includes("United Kingdom"));
  assert.ok(apiCountryOptions(apis).includes("Global"));
  assert.equal(filterApis(apis, { ...EMPTY_FILTERS, country: "United Kingdom" }).length, 1);
  assert.equal(filterApis(apis, { ...EMPTY_FILTERS, country: "Global" }).length, 1);
});

test("an endpoint is shown as an operation: method first, and nothing invented when it is unknown", () => {
  const withMethod = normalizeApiRecord({
    id: "a", api_endpoint: "https://vpfe.dian.gov.co/WcfDianCustomerServices.svc", http_method: "POST",
  });
  const withoutMethod = normalizeApiRecord({ id: "b", api_endpoint: "https://example.test/x" });
  const withoutEndpoint = normalizeApiRecord({ id: "c" });
  assert.equal(operationLabel(withMethod), "POST https://vpfe.dian.gov.co/WcfDianCustomerServices.svc");
  assert.equal(operationLabel(withoutMethod), "https://example.test/x");
  assert.equal(operationLabel(withoutEndpoint), "Endpoint not recorded");
});

test("the operation selector is split into the name and the value the document states", () => {
  const soap = normalizeApiRecord({
    id: "a",
    operation_selector: "SOAPAction=http://wcf.dian.colombia/IWcfDianCustomerServices/SendBillSync",
  });
  assert.deepEqual(operationSelectorNote(soap), {
    name: "SOAPAction",
    value: "http://wcf.dian.colombia/IWcfDianCustomerServices/SendBillSync",
  });
  // Only the first '=' divides: a value may contain more of them.
  assert.deepEqual(operationSelectorNote(normalizeApiRecord({ id: "b", operation_selector: "q=a=b" })),
                   { name: "q", value: "a=b" });
  // Nothing recorded, and nothing invented.
  assert.equal(operationSelectorNote(normalizeApiRecord({ id: "c" })), null);
  assert.equal(operationSelectorNote(normalizeApiRecord({ id: "d", operation_selector: "=x" })), null);
});

test("records that cannot be told apart by endpoint and method are found, and a different method is not one of them", () => {
  const apis = [
    normalizeApiRecord({ id: "sync", api_name: "Synchronous submission", api_endpoint: "https://x.test/svc", http_method: "POST" }),
    normalizeApiRecord({ id: "async", api_name: "Asynchronous submission", api_endpoint: "https://x.test/svc", http_method: "POST" }),
    normalizeApiRecord({ id: "get", api_name: "Retrieve", api_endpoint: "https://x.test/svc", http_method: "GET" }),
    normalizeApiRecord({ id: "elsewhere", api_name: "Other service", api_endpoint: "https://y.test/svc", http_method: "POST" }),
  ];
  assert.deepEqual(sharesEndpointWith(apis[0], apis).map((api) => api.id), ["async"]);
  assert.deepEqual(sharesEndpointWith(apis[2], apis).map((api) => api.id), []);
  // A record with no endpoint shares nothing, rather than sharing with every
  // other record that also has none.
  assert.deepEqual(sharesEndpointWith(normalizeApiRecord({ id: "blank" }), apis), []);
});
