export const DISCOVERY_MODES = ["text", "bpmn", "audio"] as const;
export type DiscoveryMode = (typeof DISCOVERY_MODES)[number];

export interface DiscoveryUpload {
  name: string;
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type DiscoveryInput =
  | { mode: "text"; text: string }
  | { mode: "bpmn"; file: DiscoveryUpload; bpmn_xml?: string }
  | { mode: "audio"; file: DiscoveryUpload };

export interface DiscoverySource {
  mode: DiscoveryMode;
  file_name?: string;
  mime_type?: string;
}

export interface DiscoveryProcessJson {
  version: "1.0";
  input_text: string;
  steps: Array<{
    order: number;
    category: "Transformation" | "Validation" | "Communication";
    task: string;
    input_format: string | null;
    output_format: string | null;
    rule_set: string | null;
    candidate_ids: null;
  }>;
  unmatched: string[];
}
