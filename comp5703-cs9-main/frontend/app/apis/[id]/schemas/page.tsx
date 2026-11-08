import SchemaPanel from "@/components/schema-panel";
import SiteFooter from "@/components/site-footer";
import SiteHeader from "@/components/site-header";
import { getCurrentAppUser } from "@/lib/auth";

export const metadata = {
  title: "API schemas",
};

type ApiSchemasPageProps = {
  params: Promise<{ id: string }>;
};

// A page of its own rather than a panel inside the catalogue: the record view
// in api-repository.tsx is being reworked for the comparison screen, and this
// keeps the two changes out of each other's way. The catalogue can link here.
export default async function ApiSchemasPage({ params }: ApiSchemasPageProps) {
  const [{ id }, user] = await Promise.all([params, getCurrentAppUser().catch(() => null)]);
  return (
    <>
      <SiteHeader active="apis" user={user} />
      <main id="main-content">
        <SchemaPanel apiId={id} signedIn={Boolean(user)} />
      </main>
      <SiteFooter signedIn={Boolean(user)} />
    </>
  );
}
