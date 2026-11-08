import { redirect } from "next/navigation";
import ComposedInvoiceWorkspace from "@/components/composed-invoice-workspace";
import SiteFooter from "@/components/site-footer";
import SiteHeader from "@/components/site-header";
import { getCurrentAppUser } from "@/lib/auth";
import { defaultRecipient } from "@/lib/default-recipient";

export const metadata = {
  title: "Composed API: Peppol invoice",
};

/**
 * Signed-in people only: every run spends the group's generator quota, and
 * the route behind it checks again.
 */
export default async function ComposedInvoicePage() {
  const user = await getCurrentAppUser().catch(() => null);
  if (!user) redirect("/login?next=%2Fcompose%2Fpeppol-invoice");

  return (
    <>
      <SiteHeader active="compose" user={user} />
      <ComposedInvoiceWorkspace accountEmail={defaultRecipient(user)} />
      <SiteFooter signedIn={Boolean(user)} />
    </>
  );
}
