import CompatibilityWorkspace from "@/components/compatibility-workspace";
import SiteFooter from "@/components/site-footer";
import SiteHeader from "@/components/site-header";
import { getCurrentAppUser } from "@/lib/auth";

export const metadata = {
  title: "Compatibility Check",
};

export default async function CompatibilityPage() {
  const user = await getCurrentAppUser().catch(() => null);

  return (
    <>
      <SiteHeader active="compatibility" user={user} />
      <CompatibilityWorkspace isSignedIn={Boolean(user)} />
      <SiteFooter signedIn={Boolean(user)} />
    </>
  );
}
