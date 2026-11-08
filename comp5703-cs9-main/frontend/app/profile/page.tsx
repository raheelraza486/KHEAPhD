import { redirect } from "next/navigation";
import ApiRepository from "@/components/api-repository";
import ManageSavedChain from "@/components/manage-saved-chain";
import SiteFooter from "@/components/site-footer";
import SiteHeader from "@/components/site-header";
import { getCurrentAppUser } from "@/lib/auth";
import { isSavedChainStorageMissing, SAVED_CHAIN_SETUP_MESSAGE, type SavedChain } from "@/lib/saved-chains";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata = { title: "Profile" };

const PAGE_SIZE = 20;

async function MyChains({ ownerId, page }: { ownerId: string; page: number }) {
  const supabase = await createSupabaseServerClient();
  const start = (page - 1) * PAGE_SIZE;
  const { data, error } = await supabase.from("saved_chain").select("id,name,api_ids,created_at")
    .eq("owner_id", ownerId).order("created_at", { ascending: false }).order("id").range(start, start + PAGE_SIZE);
  if (error) return <p className="form-error" role="alert">{isSavedChainStorageMissing(error.code)
    ? SAVED_CHAIN_SETUP_MESSAGE : "Saved chains are unavailable. Please try again later."}</p>;

  const chains: SavedChain[] = data.slice(0, PAGE_SIZE);
  const ids = [...new Set(chains.flatMap((chain) => chain.api_ids))];
  const catalogue = ids.length
    ? await supabase.from("v_catalogue").select("id,api_name,company_name").in("id", ids)
    : { data: [], error: null };
  const apis = new Map(catalogue.data?.map((api) => [api.id, api]));

  return <>
    <p>API chains you saved from workflow results. Only your account can access this list.</p>
    {catalogue.error && <p className="form-error" role="alert">API details are temporarily unavailable.</p>}
    {chains.length === 0 && (page === 1
      ? <p>No saved chains yet. <a href="/workflows/create">Create a workflow</a> to choose and save a chain.</p>
      : <p>There are no chains on this page.</p>)}
    <div className="profile-chain-list">
      {chains.map((chain) => <article className="discovery-panel" key={chain.id}>
        <h2>{chain.name}</h2>
        <p>Saved <time dateTime={chain.created_at}>{new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeZone: "Australia/Sydney" }).format(new Date(chain.created_at))}</time></p>
        <ol>{chain.api_ids.map((id, index) => {
          const api = apis.get(id);
          return <li key={`${id}-${index}`}>{api ? <><a href={`/apis?api=${id}`}>{api.api_name}</a> · {api.company_name}</> : "API unavailable"}</li>;
        })}</ol>
        {chain.api_ids.every((id) => apis.has(id)) && <a className="button secondary" href={`/workflows/canvas?saved_chain=${chain.id}`}>Open on the canvas</a>}
        <ManageSavedChain chain={chain} />
      </article>)}
    </div>
    {(page > 1 || data.length > PAGE_SIZE) && <nav className="draft-actions" aria-label="My Chains pages">
      {page > 1 && <a className="button secondary" href={`/profile?page=${page - 1}`}>Previous page</a>}
      {data.length > PAGE_SIZE && <a className="button secondary" href={`/profile?page=${page + 1}`}>Next page</a>}
    </nav>}
  </>;
}

export default async function ProfilePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [params, user] = await Promise.all([searchParams, getCurrentAppUser().catch(() => null)]);
  const submissions = params.view === "submissions";
  if (!user) {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === "string") next.set(key, value);
    }
    redirect(`/login?next=${encodeURIComponent(next.size ? `/profile?${next}` : "/profile")}`);
  }
  const requestedPage = typeof params.page === "string" ? Number(params.page) : 1;
  const page = Number.isInteger(requestedPage) && requestedPage > 0 && requestedPage <= 1_000_000 ? requestedPage : 1;

  return <>
    <SiteHeader active="profile" user={user} />
    <div className="profile-heading">
      <p className="eyebrow">Profile</p>
      <p><strong>{user.displayName || user.email}</strong></p>
      <nav className="profile-tabs" aria-label="Profile sections">
        <a className="button secondary" href="/profile" aria-current={!submissions ? "page" : undefined}>My Chains</a>
        <a className="button secondary" href="/profile?view=submissions" aria-current={submissions ? "page" : undefined}>My Submissions</a>
      </nav>
    </div>
    {submissions ? <ApiRepository initialRecords={[]} userId={user.id} role={user.role} profileSubmissions />
      : <main id="main-content" className="discovery-shell profile-chains">
        <h1>My Chains</h1>
        <MyChains ownerId={user.id} page={page} />
      </main>}
    <SiteFooter signedIn />
  </>;
}
