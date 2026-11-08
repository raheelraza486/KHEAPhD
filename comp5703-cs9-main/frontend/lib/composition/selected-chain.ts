import type { ChainLink } from "@/lib/composition/types";
import type { DiscoveryProcessJson } from "@/lib/discovery/types";

export const SELECTED_CHAIN_STORAGE_KEY = "bp-builder:selected-chain:v1";

export type SelectedChainApi = {
  step_order: number;
  category: string;
  api_id: string;
  api_name: string;
  company_name: string;
  score: number;
  matched_terms: string[];
  candidate_source: "discovery" | "keywords" | "formats" | "none";
  system_added?: { original_order: number; reason: string };
};

export type SelectedCompositionChain = {
  version: "1.0";
  /** Optional for legacy saved selections; execution availability still uses exact API IDs. */
  workflow_draft_id?: string;
  process: DiscoveryProcessJson;
  chain: {
    api_ids: string[];
    links: ChainLink[];
    status: "feasible";
  };
  apis: SelectedChainApi[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSelectedCompositionChain(
  value: string | null,
): SelectedCompositionChain | null {
  if (!value) return null;

  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || parsed.version !== "1.0") return null;
    if (!isRecord(parsed.process) || !isRecord(parsed.chain)) return null;
    if (parsed.workflow_draft_id !== undefined && (typeof parsed.workflow_draft_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed.workflow_draft_id))) return null;

    const chain = parsed.chain;
    const apiIds = chain.api_ids;
    if (chain.status !== "feasible") return null;
    if (
      !Array.isArray(apiIds) ||
      apiIds.length === 0 ||
      !apiIds.every(
        (apiId) => typeof apiId === "string" && apiId.length > 0,
      )
    ) {
      return null;
    }
    if (!Array.isArray(chain.links) || !Array.isArray(parsed.apis)) {
      return null;
    }
    if (parsed.apis.length !== apiIds.length) return null;
    if (
      !parsed.apis.every(
        (api, index) =>
          isRecord(api) &&
          api.api_id === apiIds[index] &&
          typeof api.api_name === "string" &&
          typeof api.category === "string",
      )
    ) {
      return null;
    }

    return parsed as SelectedCompositionChain;
  } catch {
    return null;
  }
}
