export const SAVED_CHAIN_NAME_LIMIT = 120;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A workflow name allows only letters, digits, "-" and "_": spaces become "-" so a label stays readable. */
export function workflowNameFromLabel(label: string) {
  return label.trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9_-]/g, "").replace(/-{2,}/g, "-").slice(0, 80);
}

export const SAVED_CHAIN_SETUP_MESSAGE = "Saved chains are unavailable in this environment. Apply the saved chains database migration (0056) and try again.";

export function isSavedChainStorageMissing(code: string) {
  return code === "PGRST205" || code === "42P01";
}

export type SavedChain = {
  id: string;
  name: string;
  api_ids: string[];
  created_at: string;
};

export type SavedChainActionState = { error?: string; saved?: boolean };
