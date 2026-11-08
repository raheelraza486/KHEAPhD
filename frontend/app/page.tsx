import HomeRepositoryTools from "@/components/home-repository-tools";
import SiteFooter from "@/components/site-footer";
import SiteHeader from "@/components/site-header";
import { getCurrentAppUser } from "@/lib/auth";
import { SUBMITTER_ROLES, hasAllowedRole } from "@/lib/auth-policy";

export default async function HomePage() {
  const user = await getCurrentAppUser().catch(() => null);
  const canSubmit = user ? hasAllowedRole(user.role, SUBMITTER_ROLES) : false;

  return (
    <>
      <SiteHeader active="home" user={user} />
      <main className="landing-page" id="main-content">
        <HomeRepositoryTools
          access={canSubmit ? "submitter" : user ? "viewer" : "signed-out"}
        />
      </main>
      <SiteFooter signedIn={Boolean(user)} />
    </>
  );
}
