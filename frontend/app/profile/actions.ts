"use server";

import { revalidatePath } from "next/cache";
import { getCurrentAppUser } from "@/lib/auth";
import { MAX_STEPS } from "@/lib/composition/types";
import { isSavedChainStorageMissing, SAVED_CHAIN_NAME_LIMIT, SAVED_CHAIN_SETUP_MESSAGE, UUID, type SavedChainActionState } from "@/lib/saved-chains";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function readName(form: FormData) {
  const value = form.get("name");
  const name = typeof value === "string" ? value.trim() : "";
  return name && name.length <= SAVED_CHAIN_NAME_LIMIT ? name : null;
}

export async function saveChain(_: SavedChainActionState, form: FormData): Promise<SavedChainActionState> {
  const name = readName(form);
  if (!name) return { error: "Enter a chain name of up to 120 characters." };
  const value = form.get("api_ids");
  const apiIds = typeof value === "string" && value.length <= MAX_STEPS * 37
    ? value.toLowerCase().split(",") : [];
  if (!apiIds.length || apiIds.length > MAX_STEPS || apiIds.some((id) => !UUID.test(id))) {
    return { error: "Choose a valid API chain before saving." };
  }

  try {
    const user = await getCurrentAppUser();
    if (!user) return { error: "Sign in to save a chain." };
    const supabase = await createSupabaseServerClient();
    const { data: apis, error: lookupError } = await supabase.from("v_catalogue").select("id").in("id", apiIds);
    if (lookupError) return { error: "The API catalogue is temporarily unavailable." };
    if (apis.length !== new Set(apiIds).size) return { error: "An API in this chain is no longer available in the catalogue." };

    const { error } = await supabase.from("saved_chain").upsert(
      { name, api_ids: apiIds }, { onConflict: "owner_id,name,api_ids", ignoreDuplicates: true },
    );
    if (error) {
      console.error("Saved chain write failed", { code: error.code });
      if (isSavedChainStorageMissing(error.code)) return { error: SAVED_CHAIN_SETUP_MESSAGE };
      if (error.code === "42501") return { error: "The database denied access to saved chains. Sign in again or contact the administrator." };
      return { error: "The chain could not be saved. Please try again." };
    }
  } catch {
    return { error: "The chain could not be saved. Please try again." };
  }
  revalidatePath("/profile");
  return { saved: true };
}

export async function updateSavedChain(_: SavedChainActionState, form: FormData): Promise<SavedChainActionState> {
  const id = form.get("id");
  const intent = form.get("intent");
  if (typeof id !== "string" || !UUID.test(id) || (intent !== "rename" && intent !== "delete")) {
    return { error: "Choose a saved chain." };
  }
  const name = readName(form);
  if (intent === "rename" && !name) return { error: "Enter a chain name of up to 120 characters." };

  try {
    const user = await getCurrentAppUser();
    if (!user) return { error: "Sign in to manage your chains." };
    const supabase = await createSupabaseServerClient();
    const table = supabase.from("saved_chain");
    const mutation = intent === "delete" ? table.delete() : table.update({ name });
    const { data, error } = await mutation.eq("id", id).eq("owner_id", user.id).select("id").maybeSingle();
    if (error?.code === "23505") return { error: "You already saved these API steps under that name." };
    if (error) return { error: "The change could not be saved. Please try again." };
    if (!data) return { error: "This saved chain is unavailable." };
  } catch {
    return { error: "The change could not be saved. Please try again." };
  }
  revalidatePath("/profile");
  return { saved: true };
}
