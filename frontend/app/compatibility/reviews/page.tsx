import { redirect } from "next/navigation";
import AdminReviewWorkspace from "@/components/admin-review-workspace";
import SiteFooter from "@/components/site-footer";
import SiteHeader from "@/components/site-header";
import { ADMIN_ROLES, getCurrentAppUser } from "@/lib/auth";
import type { AppRole } from "@/lib/auth-policy";

export const metadata = {
  title: "Pending review",
};

/**
 * Administrators only. The routes behind this page check the role again, so
 * this redirect is for the person, not for security: someone who is not an
 * administrator has nothing to do here.
 */
export default async function CompatibilityReviewsPage() {
  const user = await getCurrentAppUser().catch(() => null);
  if (!user) redirect("/login?next=%2Fcompatibility%2Freviews");
  if (!(ADMIN_ROLES as readonly AppRole[]).includes(user.role)) redirect("/compatibility");

  return (
    <>
      <SiteHeader active="reviews" user={user} />
      <AdminReviewWorkspace />
      <SiteFooter signedIn={Boolean(user)} />
    </>
  );
}
