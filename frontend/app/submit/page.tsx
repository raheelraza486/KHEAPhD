import { redirect } from "next/navigation";
import ImportWorkflow from "@/components/import-workflow";
import SiteFooter from "@/components/site-footer";
import SiteHeader from "@/components/site-header";
import { getCurrentAppUser } from "@/lib/auth";
import { SUBMITTER_ROLES, hasAllowedRole } from "@/lib/auth-policy";

type SubmitPageProps = {
  searchParams: Promise<{ url?: string | string[] }>;
};

export const metadata = {
  title: "Submit an API",
};

export default async function SubmitPage({ searchParams }: SubmitPageProps) {
  const [user, params] = await Promise.all([
    getCurrentAppUser().catch(() => null),
    searchParams,
  ]);
  if (!user) redirect(`/login?next=${encodeURIComponent("/submit")}`);
  if (!hasAllowedRole(user.role, SUBMITTER_ROLES)) redirect("/");
  const suppliedUrl = typeof params.url === "string" ? params.url.slice(0, 2048) : "";

  return <>
    <SiteHeader active="submit" user={user} />
    <main className="app-shell submit-shell" id="main-content">
      <section className="workspace submit-workspace">
        <ImportWorkflow
          submittedBy={user.displayName || user.email}
          initialUrl={suppliedUrl}
        />
      </section>
    </main>
    <SiteFooter signedIn={Boolean(user)} />
  </>;
}
