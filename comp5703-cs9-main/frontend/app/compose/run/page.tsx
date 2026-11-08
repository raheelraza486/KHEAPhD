import CompositionRunWorkspace from "@/components/composition-run-workspace";
import SiteFooter from "@/components/site-footer";
import SiteHeader from "@/components/site-header";
import { getCurrentAppUser } from "@/lib/auth";

export const metadata = {
  title: "Composition Run",
};

export default async function CompositionRunPage() {
  const user = await getCurrentAppUser().catch(() => null);

  return (
    <>
      <SiteHeader active="workflow" user={user} />
      <CompositionRunWorkspace />
      <SiteFooter signedIn={Boolean(user)} />
    </>
  );
}
