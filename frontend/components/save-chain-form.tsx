"use client";

import { useActionState } from "react";
import { saveChain } from "@/app/profile/actions";
import { SAVED_CHAIN_NAME_LIMIT } from "@/lib/saved-chains";

export default function SaveChainForm({ apiIds }: { apiIds: string[] }) {
  const [state, action, pending] = useActionState(saveChain, {});
  return <form action={action} className="saved-chain-form">
    <input type="hidden" name="api_ids" value={apiIds.join(",")} />
    <label>Chain name <input name="name" placeholder="e.g. Australian invoice delivery" required maxLength={SAVED_CHAIN_NAME_LIMIT} /></label>
    <button className="button secondary" disabled={pending}>{pending ? "Saving…" : "Save chain"}</button>
    {state.error && <p className="form-error" role="alert">{state.error}</p>}
    {state.saved && <p role="status">Saved to <a href="/profile">My Chains</a>.</p>}
  </form>;
}
