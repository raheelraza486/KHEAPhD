import type { SelectedCompositionChain } from "@/lib/composition/selected-chain";

const UPBRAINS_API_ID = "974405cd-82b2-4e76-a628-278a56ac4e9a";
const AMIT_TRANSFORM_API_ID = "17455a7a-f107-4180-a907-0f8879bcd746";
const ESS_SMART_DOC_FLOW_API_ID = "10feb4e1-16d8-4f67-8463-99d44565580d";
const MAILGUN_API_ID = "08885479-e750-4a42-99d6-b4d32ad62983";
const B2B_ROUTER_API_ID = "8c305642-44f0-4400-ae99-49801ae06131";

export type ExecutionAvailability =
  | {
      status: "available";
      integration: "pdf_invoice_email" | "pdf_invoice_peppol";
      label: string;
      description: string;
      workflowHref: "/compose/pdf-invoice";
      endpoint: "/api/composed/pdf-invoice";
    }
  | {
      status: "integration_unavailable";
      integration: null;
      label: "Integration unavailable";
      description: string;
    };

type RegisteredExecution = Extract<ExecutionAvailability, { status: "available" }> & {
  apiIds: readonly string[];
};

const SHARED_PREFIX = [
  UPBRAINS_API_ID,
  AMIT_TRANSFORM_API_ID,
  ESS_SMART_DOC_FLOW_API_ID,
] as const;

const EXECUTION_REGISTRY: readonly RegisteredExecution[] = [
  {
    apiIds: [...SHARED_PREFIX, MAILGUN_API_ID],
    status: "available",
    integration: "pdf_invoice_email",
    label: "PDF invoice to email delivery",
    description:
      "This exact API chain is connected to the existing PDF invoice email workflow.",
    workflowHref: "/compose/pdf-invoice",
    endpoint: "/api/composed/pdf-invoice",
  },
  {
    apiIds: [...SHARED_PREFIX, B2B_ROUTER_API_ID],
    status: "available",
    integration: "pdf_invoice_peppol",
    label: "PDF invoice to Peppol delivery",
    description:
      "This exact API chain is connected to the existing PDF invoice Peppol workflow.",
    workflowHref: "/compose/pdf-invoice",
    endpoint: "/api/composed/pdf-invoice",
  },
];

function hasExactApiSequence(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((apiId, index) => apiId === expected[index])
  );
}

export function getExecutionAvailability(
  selected: Pick<SelectedCompositionChain, "chain">,
): ExecutionAvailability {
  const registration = EXECUTION_REGISTRY.find(({ apiIds }) =>
    hasExactApiSequence(selected.chain.api_ids, apiIds),
  );

  if (registration) {
    const { apiIds: _apiIds, ...availability } = registration;
    return availability;
  }

  return {
    status: "integration_unavailable",
    integration: null,
    label: "Integration unavailable",
    description:
      "This chain passed composition checks, but no execution integration is registered for its exact API sequence.",
  };
}
