import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import DraftWorkspace from '@/components/draft-workspace';
import SiteHeader from '@/components/site-header';
import SiteFooter from '@/components/site-footer';
import { getCurrentAppUser } from '@/lib/auth';

export const metadata = { title: 'Create a workflow' };
export default async function WorkflowPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const user = await getCurrentAppUser().catch(() => null);
  if (!user) {
    const params = new URLSearchParams();
    if (typeof query.step === 'string') params.set('step', query.step);
    redirect(`/login?next=${encodeURIComponent(`/workflows/create${params.size ? `?${params}` : ''}`)}`);
  }
  return <><SiteHeader active="workflow" user={user} /><Suspense fallback={<main id="main-content">Loading workflow…</main>}><DraftWorkspace kind="workflow" /></Suspense><SiteFooter signedIn /></>;
}
