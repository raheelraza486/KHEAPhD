import { redirect } from "next/navigation";
import PdfInvoiceWorkspace from "@/components/pdf-invoice-workspace";
import SiteFooter from "@/components/site-footer";
import SiteHeader from "@/components/site-header";
import { getCurrentAppUser } from "@/lib/auth";
import { ademicoConfigFromEnv } from "@/lib/composition/peppol-invoice";
import { defaultRecipient } from "@/lib/default-recipient";

export const metadata = {
  title: "Process and send a PDF invoice",
};

/**
 * Signed-in people only: every run spends extraction credits on the client's
 * own account, and the route behind it checks again.
 */
export default async function PdfInvoicePage() {
  const user = await getCurrentAppUser().catch(() => null);
  if (!user) redirect("/login?next=%2Fcompose%2Fpdf-invoice");

  return (
    <>
      <SiteHeader active="compose" user={user} />
      <PdfInvoiceWorkspace accountEmail={defaultRecipient(user)} ademicoAvailable={ademicoConfigFromEnv() !== null} />
      <SiteFooter signedIn={Boolean(user)} />
    </>
  );
}
