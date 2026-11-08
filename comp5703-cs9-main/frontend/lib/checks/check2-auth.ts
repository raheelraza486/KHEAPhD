/**
 * Check item 2.0 · authentication comparison (Check Manual §7.3).
 * Information only — the verdict is always `pass`.
 */
import type { AuthResult, PairInput } from "./types.ts";

/** Wording in `authentication_details` that means the credential comes from another call. */
const PRIOR_CALL = /\b(obtained|exchange[sd]?|returned by|seed|issued by (?:the )?(?:token|login|auth)|login endpoint|token endpoint)\b/i;

const NO_CREDENTIAL = new Set(["none", ""]);

export function runAuth(input: PairInput): AuthResult {
  const s = input.source.api;
  const t = input.target.api;
  const sMethod = (s.authentication_method ?? "").trim();
  const tMethod = (t.authentication_method ?? "").trim();
  const sNeeds = !NO_CREDENTIAL.has(sMethod.toLowerCase());
  const tNeeds = !NO_CREDENTIAL.has(tMethod.toLowerCase());

  let sets: 0 | 1 | 2;
  if (!sNeeds && !tNeeds) sets = 0;
  else if (sNeeds && tNeeds && s.company_name === t.company_name && sMethod === tMethod) sets = 1;
  else if (sNeeds && tNeeds) sets = 2;
  else sets = 1;

  return {
    status: "pass",
    credential_sets: sets,
    source_auth: { method: s.authentication_method, details: s.authentication_details },
    target_auth: { method: t.authentication_method, details: t.authentication_details },
    auth_requires_prior_call: PRIOR_CALL.test(t.authentication_details ?? ""),
  };
}
