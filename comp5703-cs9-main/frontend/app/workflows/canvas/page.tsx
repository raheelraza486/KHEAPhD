import { notFound, redirect } from "next/navigation";
import SiteFooter from "@/components/site-footer";
import SiteHeader from "@/components/site-header";
import WorkflowCanvas from "@/components/workflow-canvas";
import { getCurrentAppUser } from "@/lib/auth";
import { defaultRecipient } from "@/lib/default-recipient";
import { UUID, workflowNameFromLabel } from "@/lib/saved-chains";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata = { title: "Workflow canvas" };

/** `/workflows/canvas?api_ids=<id>,<id>…&name=<name>`: the chain to open, in process order. */
export default async function WorkflowCanvasPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const user = await getCurrentAppUser().catch(() => null);
  let ids = typeof query.api_ids === "string" ? query.api_ids.split(",").map((id) => id.trim()).filter((id) => UUID.test(id)).slice(0, 4) : [];
  let name = typeof query.name === "string" ? query.name : "";
  const savedId = query.saved_chain;
  if (savedId !== undefined) {
    if (typeof savedId !== "string" || !UUID.test(savedId)) notFound();
    if (!user) redirect(`/login?next=${encodeURIComponent(`/workflows/canvas?saved_chain=${savedId}`)}`);
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.from("saved_chain").select("name,api_ids")
      .eq("owner_id", user.id).eq("id", savedId).maybeSingle();
    if (error) throw new Error("The saved chain could not be loaded.");
    if (!data) notFound();
    ids = data.api_ids;
    name = data.name;
  }
  return (
    <>
      <SiteHeader active="canvas" user={user} />
      <WorkflowCanvas initialIds={ids} initialName={workflowNameFromLabel(name)} savedChainId={typeof savedId === "string" ? savedId : undefined} canDeploy={user?.role === "admin"} accountEmail={user?.role === "admin" ? defaultRecipient(user) : undefined} />
      <SiteFooter signedIn={Boolean(user)} />
    </>
  );
}
