import { redirect } from "next/navigation";
import { Suspense } from 'react';
import DiscoveryWorkspace from "@/components/discovery-workspace";
import SiteFooter from "@/components/site-footer";
import SiteHeader from "@/components/site-header";
import { getCurrentAppUser } from "@/lib/auth";

export const metadata = {
  title: "API Discovery",
};

export default async function DiscoveryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const user = await getCurrentAppUser().catch(() => null);
  if (!user) {
    const params = new URLSearchParams();
    if (typeof query.step === 'string') params.set('step', query.step);
    redirect(`/login?next=${encodeURIComponent(`/discovery${params.size ? `?${params}` : ''}`)}`);
  }

  return (
    <>
      <SiteHeader active="discovery" user={user} />
      <Suspense fallback={<main id="main-content">Loading Discovery…</main>}><DiscoveryWorkspace /></Suspense>
      <SiteFooter signedIn={Boolean(user)} />
    </>
  );
}
