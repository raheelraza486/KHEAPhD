"use client";

import { useState } from "react";
import type { Chain } from "@/lib/composition/types";

/**
 * "Generate AWS workflow" for one chain on the BP-Builder results page (#62).
 *
 * Pass the chain exactly as `/api/composition` returns it in
 * `composition.chains[]`: its `api_ids` (in process order) and `status` are
 * all the endpoint needs, so the button does not depend on how the page keeps
 * the selected chain. It downloads `<name>.zip` with the Step Functions
 * definition (JSON and YAML), one Lambda wrapper per API and a README.
 */
export default function GenerateWorkflowButton({ chain, name }: { chain: Pick<Chain, "api_ids" | "status">; name?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function generate() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/composition/workflow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_ids: chain.api_ids, status: chain.status, ...(name ? { name } : {}) }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string; details?: Array<{ message: string }> } | null;
        const detail = body?.details?.map((issue) => issue.message).join(" ");
        throw new Error([body?.error ?? `The workflow could not be generated (${response.status}).`, detail].filter(Boolean).join(" "));
      }
      const blob = await response.blob();
      const fileName = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ?? "workflow.zip";
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The workflow could not be generated.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="generate-workflow">
      <button type="button" className="button secondary" onClick={generate} disabled={busy || chain.api_ids.length === 0}>
        {busy ? "Generating…" : "Generate workflow"}
      </button>
      {chain.status === "needs_decision" && !error && (
        <p className="composed-totals">This chain still needs a decision; the workflow may fail at that link.</p>
      )}
      {error && <p className="composed-totals composed-totals-error" role="alert">{error}</p>}
    </div>
  );
}
