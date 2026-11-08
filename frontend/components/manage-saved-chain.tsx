"use client";

import { useActionState } from "react";
import { updateSavedChain } from "@/app/profile/actions";
import { SAVED_CHAIN_NAME_LIMIT, type SavedChain } from "@/lib/saved-chains";

export default function ManageSavedChain({ chain }: { chain: SavedChain }) {
  const [state, action, pending] = useActionState(updateSavedChain, {});
  return <details>
    <summary>Manage chain</summary>
    <form action={action} className="saved-chain-form">
      <input type="hidden" name="id" value={chain.id} />
      <label>Chain name <input name="name" defaultValue={chain.name} required maxLength={SAVED_CHAIN_NAME_LIMIT} /></label>
      <div className="draft-actions">
        <button className="button secondary" name="intent" value="rename" disabled={pending}>Rename</button>
        <button className="button secondary" name="intent" value="delete" formNoValidate disabled={pending}
          onClick={(event) => { if (!window.confirm(`Delete “${chain.name}” from My Chains?`)) event.preventDefault(); }}>Delete</button>
      </div>
      {state.error && <p className="form-error" role="alert">{state.error}</p>}
      {state.saved && <p role="status">Chain updated.</p>}
    </form>
  </details>;
}
