import { redirect } from "next/navigation";
import ApiRepository from "@/components/api-repository";
import SiteFooter from "@/components/site-footer";
import SiteHeader from "@/components/site-header";
import { getCurrentAppUser } from "@/lib/auth";
import {
  normalizeCatalogueCategory,
  normalizeCatalogueDirection,
} from "@/lib/catalog-category-filter";
import { ALL_COUNTRY_REGIONS } from "@/lib/country-region";

type ApiDirectoryPageProps = {
  searchParams: Promise<{ q?: string; category?: string; country?: string; direction?: string; scope?: string; status?: string; api?: string }>;
};

export default async function ApiDirectoryPage({ searchParams }: ApiDirectoryPageProps) {
  const [params, user] = await Promise.all([
    searchParams,
    getCurrentAppUser().catch(() => null),
  ]);
  if (params.scope === "mine" && user?.role !== "admin") {
    const profile = new URLSearchParams({ view: "submissions" });
    for (const [key, value] of Object.entries(params)) {
      if (key !== "scope" && key !== "view" && typeof value === "string") profile.set(key, value);
    }
    redirect(`/profile?${profile}`);
  }
  const initialCategory = normalizeCatalogueCategory(params.category);
  const initialCommunicationDirection = normalizeCatalogueDirection(
    initialCategory,
    params.direction,
  );

  return (
    <>
      <SiteHeader
        active="apis"
        user={user}
        apiView={params.status === "Published" && user?.role === "admin" ? "awaiting" : params.scope === "mine" && user && user.role !== "admin" ? "mine" : "all"}
      />
      <ApiRepository
        initialRecords={[]}
        initialQuery={params.q ?? ""}
        initialCategory={initialCategory}
        initialCommunicationDirection={initialCommunicationDirection}
        initialCountryRegion={params.country ?? ALL_COUNTRY_REGIONS}
        initialScope={params.scope === "mine" ? "mine" : "all"}
        initialStatus={params.status === "Verified" || params.status === "Published" ? params.status : "All records"}
        initialApiId={params.api ?? ""}
        userId={user?.id ?? null}
        role={user?.role ?? null}
      />
      <SiteFooter signedIn={Boolean(user)} />
    </>
  );
}
