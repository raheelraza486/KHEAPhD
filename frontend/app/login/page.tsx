import { redirect } from "next/navigation";
import AuthLoginForm from "@/components/login-form";
import SiteFooter from "@/components/site-footer";
import SiteHeader from "@/components/site-header";
import { getCurrentAppUser } from "@/lib/auth";
import { safeInternalPath } from "@/lib/auth-redirect";

export const metadata = {
  title: "Log in — Business API Repository",
};

type LoginPageProps = {
  searchParams: Promise<{ next?: string | string[] }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const requestedNext = typeof params.next === "string" ? params.next : undefined;
  const nextPath = safeInternalPath(requestedNext);
  const user = await getCurrentAppUser().catch(() => null);

  if (user) redirect(nextPath);

  return (
    <>
      <SiteHeader active="login" user={null} />
      <main className="login-page" id="main-content">
        <section className="login-card" aria-labelledby="login-title">
          <p className="eyebrow">Repository access</p>
          <h1 id="login-title">Log in to your account</h1>
          <p className="login-lead">
            Sign in to submit APIs, manage your submissions and follow verification updates in your inbox. Administrators verify catalogue records.
          </p>
          <AuthLoginForm nextPath={nextPath} />
        </section>
      </main>
      <SiteFooter signedIn={Boolean(user)} />
    </>
  );
}
