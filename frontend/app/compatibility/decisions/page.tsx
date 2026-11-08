import { redirect } from "next/navigation";
import MyDecisionsWorkspace from "@/components/my-decisions-workspace";
import SiteFooter from "@/components/site-footer";
import SiteHeader from "@/components/site-header";
import { getCurrentAppUser } from "@/lib/auth";

export const metadata = {
  title: "My field decisions",
};

/**
 * Signed-in people only: the page lists the caller's own answers, so there is
 * nothing here for a visitor. The route behind it checks again.
 */
export default async function MyDecisionsPage() {
  const user = await getCurrentAppUser().catch(() => null);
  if (!user) redirect("/login?next=%2Fcompatibility%2Fdecisions");

  return (
    <>
      <SiteHeader active="decisions" user={user} />
      <MyDecisionsWorkspace />
      <SiteFooter signedIn={Boolean(user)} />
    </>
  );
}
