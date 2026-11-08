import assert from "node:assert/strict";
import test from "node:test";

import { generateWorkflow } from "../../lib/composition/step-functions.ts";
import { END_ID, START_ID, choiceLabel, graphFromDefinition, layoutGraph, type AslDefinition } from "../../lib/workflow-canvas/graph.ts";

const CONVERT = "11111111-1111-4111-8111-111111111111";
const VALIDATE = "33333333-3333-4333-8333-333333333333";
const SEND = "44444444-4444-4444-8444-444444444444";

function row(id: string, api_name: string, category: string, company_name: string) {
  return {
    id, api_name, company_name, category, api_endpoint: `https://${company_name.toLowerCase()}.example/run`,
    http_method: "POST", authentication_method: "None", authentication_details: "", input_formats: ["JSON"], output_formats: ["XML"],
  };
}
const ROWS = [
  row(CONVERT, "AmitTransform Convert UBL JSON to UBL XML API", "Transformation", "AmitTransform"),
  row(VALIDATE, "ECOSIO Validator Validate XML Document API", "Validation", "Ecosio"),
  row(SEND, "Mailgun Send Message API", "Communication", "Mailgun"),
];

function generated(ids: string[]) {
  const result = generateWorkflow({ api_ids: ids }, ROWS);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("not generated");
  return result.workflow;
}

test("every state of the generated definition is a node, between Start and End, named as AWS shows it", () => {
  const workflow = generated([CONVERT, VALIDATE, SEND]);
  const graph = graphFromDefinition(workflow.definition, workflow.lambdas);
  assert.deepEqual(graph.nodes.map((node) => node.id), [START_ID, ...Object.keys(workflow.definition.States), END_ID]);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  assert.equal(byId.get("01 AmitTransform Convert UBL JSON to UBL XML")?.kind, "api");
  assert.equal(byId.get("01 AmitTransform Convert UBL JSON to UBL XML")?.lambda?.api_id, CONVERT);
  assert.equal(byId.get("02 ECOSIO Validator Validate XML Document")?.category, "Validation");
  assert.equal(byId.get("03 Mailgun Send Message")?.category, "Communication");
  assert.equal(byId.get("Validation failed")?.kind, "fail");
  assert.equal(byId.get("Composition failed")?.kind, "fail");
  assert.equal([...byId.values()].find((node) => node.kind === "choice")?.stateType, "Choice");
});

test("each transition is an edge: the validation branch, its default and the ends", () => {
  const workflow = generated([CONVERT, VALIDATE, SEND]);
  const edges = graphFromDefinition(workflow.definition, workflow.lambdas).edges.map((edge) => `${edge.from}>${edge.to}:${edge.kind}:${edge.label}`);
  const choice = "Check validation";
  assert.ok(edges.includes(`${START_ID}>Check workflow input:next:`));
  assert.ok(edges.includes("Check workflow input>Workflow input rejected:default:Otherwise"));
  assert.ok(edges.includes(`${choice}>03 Mailgun Send Message:choice:isValid = true`), edges.join("\n"));
  assert.ok(edges.includes(`${choice}>Validation failed:default:Otherwise`));
  assert.ok(edges.includes("02 ECOSIO Validator Validate XML Document>Composition failed:catch:On error"));
  assert.ok(edges.includes(`03 Mailgun Send Message>${END_ID}:end:`));
  assert.ok(edges.includes(`Validation failed>${END_ID}:end:`));
});

test("Catch handlers and Pass states the generator may add later are drawn too", () => {
  const definition: AslDefinition = {
    StartAt: "Read",
    States: {
      Read: { Type: "Pass", Next: "Call" },
      Call: { Type: "Task", Resource: "arn:aws:states:::lambda:invoke", Next: "Done", Catch: [{ ErrorEquals: ["States.ALL"], Next: "Failed" }] },
      Done: { Type: "Succeed" },
      Failed: { Type: "Fail", Error: "Composition.Failed" },
    },
  };
  const graph = graphFromDefinition(definition);
  assert.deepEqual(graph.nodes.map((node) => node.kind), ["start", "pass", "state", "succeed", "fail", "end"]);
  assert.ok(graph.edges.some((edge) => edge.from === "Call" && edge.to === "Failed" && edge.kind === "catch" && edge.label === "On error"));
});

test("an empty workflow is Start straight to End", () => {
  const graph = graphFromDefinition({ StartAt: "", States: {} });
  assert.deepEqual(graph.nodes.map((node) => node.id), [START_ID, END_ID]);
  assert.deepEqual(graph.edges.map((edge) => [edge.from, edge.to]), [[START_ID, END_ID]]);
});

test("choice labels keep the comparison and drop the presence checks that guard it", () => {
  assert.equal(choiceLabel({
    And: [
      { Variable: "$.validation.isValid", IsPresent: true },
      { Variable: "$.validation.isValid", IsBoolean: true },
      { Variable: "$.validation.isValid", BooleanEquals: true },
    ],
  }), "isValid = true");
  assert.equal(choiceLabel({ Variable: "$.status", StringEquals: "ok" }), 'status = "ok"');
  assert.equal(choiceLabel({ Variable: "$.body", IsPresent: true }), "body is present");
  assert.equal(choiceLabel({ And: [{ Variable: "$.document", IsPresent: true }, { Not: { Variable: "$.document", IsNull: true } }] }), "document is given");
});

test("layout: the success path runs down one column, each state below the one before, the failure beside it", () => {
  const workflow = generated([CONVERT, VALIDATE, SEND]);
  const boxes = layoutGraph(graphFromDefinition(workflow.definition, workflow.lambdas));
  const main = [START_ID, "Check workflow input", "01 AmitTransform Convert UBL JSON to UBL XML", "02 ECOSIO Validator Validate XML Document", "Check validation", "03 Mailgun Send Message", END_ID];
  const centre = (id: string) => boxes[id].x + boxes[id].width / 2;
  for (let index = 1; index < main.length; index += 1) {
    assert.ok(boxes[main[index]].y > boxes[main[index - 1]].y, `${main[index]} is below ${main[index - 1]}`);
    assert.equal(centre(main[index]), centre(main[0]), `${main[index]} is on the main column`);
  }
  const send = boxes["03 Mailgun Send Message"];
  assert.ok(boxes["Validation failed"].x > send.x + send.width, "the failure sits to the right");
  assert.ok(boxes[END_ID].y > boxes["Validation failed"].y, "End is below everything");
  assert.ok(boxes[END_ID].y > boxes["Composition failed"].y, "End is below everything");
});

test("layout: a Fail state reached only by an error handler sits beside the main column, not on it", () => {
  const boxes = layoutGraph(graphFromDefinition({
    StartAt: "Read",
    States: {
      Read: { Type: "Pass", Next: "Call" },
      Call: { Type: "Task", Resource: "x", End: true, Catch: [{ ErrorEquals: ["States.ALL"], Next: "Failed" }] },
      Failed: { Type: "Fail", Error: "Composition.Failed" },
    },
  }));
  assert.ok(boxes.Failed.x > boxes.Call.x + boxes.Call.width, "the failure sits to the right");
  assert.ok(boxes[END_ID].y > boxes.Failed.y, "End is below everything");
  assert.equal(boxes[END_ID].x + boxes[END_ID].width / 2, boxes.Call.x + boxes.Call.width / 2, "End stays on the main column");
});

test("layout survives a loop back to an earlier state", () => {
  const boxes = layoutGraph(graphFromDefinition({
    StartAt: "Poll",
    States: {
      Poll: { Type: "Task", Resource: "x", Next: "Ready" },
      Ready: { Type: "Choice", Choices: [{ Variable: "$.done", BooleanEquals: true, Next: "Finish" }], Default: "Poll" },
      Finish: { Type: "Succeed" },
    },
  }));
  assert.ok(boxes.Ready.y > boxes.Poll.y);
  assert.ok(boxes.Finish.y > boxes.Ready.y);
});
