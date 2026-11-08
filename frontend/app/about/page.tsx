import SiteFooter from "@/components/site-footer";
import SiteHeader from "@/components/site-header";
import ProductIcon from "@/components/product-icon";
import { getCurrentAppUser } from "@/lib/auth";
import { SUBMITTER_ROLES, hasAllowedRole } from "@/lib/auth-policy";

export const metadata = { title: "How it works — Business API Repository" };

export default async function AboutPage() {
  const user = await getCurrentAppUser().catch(() => null);
  const signedInHref = (path: string) => user ? path : `/login?next=${encodeURIComponent(path)}`;
  const canSubmit = user && hasAllowedRole(user.role, SUBMITTER_ROLES);
  const guides = [
    { id: "find", icon: "search" as const, title: "Find an API for a task", intro: "Know what you need? Start in the API Library.",
      steps: ["Search by API name, provider or task. Narrow the results by category, country, data format and other filters.", "Open a result to see what it does, what data it accepts and returns, and how to get access. Follow the provider’s documentation for implementation details.", "Use the arrows in API details to browse your results. Your search, filters and sort order stay in the URL, so you can return to or share the same list."],
      href: "/apis", action: "Browse APIs", note: "Public browsing · no account needed" },
    { id: "discover", icon: "search" as const, title: "Find APIs for your requirements", intro: "Have one task or several requirements in mind? Start with API Discovery.",
      steps: ["Describe the job in your own words, upload a process diagram, or upload an audio description. Your draft is saved privately.", "Check the requirements. Edit, add, remove or reorder them before finding APIs.", "Review individual API matches grouped by requirement. If you want to connect related requirements, optionally copy them into a new workflow; your Discovery draft stays saved."],
      href: signedInHref("/discovery"), action: "Open API Discovery", note: "Sign-in required · suggestions do not run the APIs" },
    { id: "workflow", icon: "workflow" as const, title: "Create a workflow from API steps", intro: "Use a separate workflow draft when you want to connect APIs.",
      steps: ["Import a confirmed Discovery draft or add your own steps. Review the order and candidate APIs.", "Check compatibility using the available API definitions and saved field decisions. Review any missing evidence.", "Explore complete API chains from the same saved evaluation. Download a workflow package or check whether a chain has a supported platform integration. Editing or starting a new draft keeps your earlier work."],
      href: signedInHref("/workflows/create"), action: "Create a workflow", note: "Sign-in required · existing workflow ordering and integration limits apply" },
    { id: "compare", icon: "compare" as const, title: "Check whether two APIs can exchange data", intro: "Compatibility compares the data one API returns with the data the next API needs.",
      steps: ["On the left, choose the first API and the data it returns — its response or output. On the right, choose the next API and the data it accepts — its request or input.", "For each side, paste a link to an OpenAPI definition, choose a saved API, or upload a definition file. An OpenAPI definition is a document describing an API’s operations and data.", "Run the comparison, then review matching fields, format differences and missing information. Signed-in users can preview and save field decisions for supported saved API pairs."],
      href: "/compatibility", action: "Check compatibility", note: "Compares API definitions · does not call the providers’ services" },
    { id: "share", icon: "upload" as const, title: "Share an API with others", intro: "Use Add API to create a listing from an OpenAPI document.",
      steps: ["Paste the public link to an OpenAPI document. Review the operations found in it and choose which ones to add.", "Check the listing information before confirming. Each selected operation becomes an API listing.", "Follow your listings in My submissions. An administrator can check the official source, mark a listing verified or ask for changes. Review feedback before editing and resubmitting."],
      href: canSubmit ? "/submit" : user ? "/profile?view=submissions" : "/login?next=%2Fsubmit", action: canSubmit || !user ? "Add an API" : "View my submissions", note: "Adding APIs requires a User or Administrator account" },
    { id: "run", icon: "grid" as const, title: "Try a working invoice workflow", intro: "Invoice workflows runs the platform’s supported invoice processes through several services.",
      steps: ["Start with a PDF invoice, or enter invoice data in the invoice generation workflow.", "Follow the page’s instructions, review the data and run the workflow. The page shows what happened at each stage, including validation and delivery results.", "Check the environment before sending: Peppol delivery uses a sandbox. These supported workflows are separate from the suggestions shown in API Discovery."],
      href: signedInHref("/compose/pdf-invoice"), action: "Start with a PDF", secondaryHref: signedInHref("/compose/peppol-invoice"), secondaryAction: "Start with invoice data", note: "Sign-in required · review each workflow’s requirements before running" },
  ];
  return <>
    <SiteHeader active="about" user={user} />
    <main className="about-page how-page" id="main-content">
      <div className="how-content">
        <header className="how-hero">
          <p className="eyebrow">How it works</p>
          <h1>Start with what you want to do.</h1>
          <p>Find an API, check how it fits with another, or try an invoice workflow. This guide shows where to start and what happens next.</p>
          <p className="how-definition"><strong>New to APIs?</strong> An API lets one application exchange information with another. This platform helps you find and compare those connections.</p>
        </header>
        <nav className="how-jump-links" aria-label="On this page">
          {guides.map((guide) => <a key={guide.id} href={`#guide-${guide.id}`}>{guide.id === "compare" ? "Check compatibility" : guide.id === "run" ? "Run an invoice workflow" : guide.id === "workflow" ? "Create a workflow" : guide.id === "discover" ? "Discover APIs" : guide.id === "share" ? "Share an API" : "Find an API"}</a>)}
          <a href="#guide-accounts">Accounts & verification</a>
        </nav>
        <div className="how-guides">
          {guides.map((guide) => <section className="how-guide" key={guide.id} id={`guide-${guide.id}`} aria-labelledby={`guide-${guide.id}-title`}>
            <span className="how-guide-icon"><ProductIcon name={guide.icon} /></span>
            <div><h2 id={`guide-${guide.id}-title`}>{guide.title}</h2><p className="how-guide-intro">{guide.intro}</p>
              <ol>{guide.steps.map((step) => <li key={step}>{step}</li>)}</ol>
              <div className="how-guide-actions"><a className="button primary" href={guide.href}>{guide.action}<span aria-hidden="true">→</span></a>{guide.secondaryHref && <a href={guide.secondaryHref}>{guide.secondaryAction} <span aria-hidden="true">→</span></a>}</div>
              <p className="how-access-note">{guide.note}</p>
            </div>
          </section>)}
        </div>
        <section className="how-accounts" id="guide-accounts" aria-labelledby="accounts-title">
          <h2 id="accounts-title">Accounts and verification</h2>
          <p>You can browse the library and compare API definitions without signing in. Sign in to use Discovery, run a supported workflow or save supported field decisions.</p>
          <dl className="how-roles">
            <div><dt>User</dt><dd>Can add APIs and manage their own submissions, as well as use the discovery and workflow tools.</dd></div>
            <div><dt>Viewer</dt><dd>Can use the signed-in tools and manage submissions they already own. This role cannot add new APIs.</dd></div>
            <div><dt>Administrator</dt><dd>Can manage listings, check APIs awaiting verification and resolve conflicting field decisions in Pending review.</dd></div>
          </dl>
          <div className="how-verification"><h3>What do the API statuses mean?</h3><p><strong>Awaiting verification:</strong> the API is listed, but an administrator has not completed its official-source check.</p><p><strong>Verified:</strong> an administrator checked an official source and recorded a verification note. Read that note and the provider’s documentation; this status does not guarantee access, availability or compatibility with another API.</p></div>
          <details><summary>Will a compatibility upload publish my API?</summary><p>No. Links and files supplied in Compatibility are used for that comparison only. Use Add API when you want to create a library listing.</p></details>
          <details><summary>Does a compatibility result mean the connection is ready to run?</summary><p>No. It describes the match between the available API definitions. You may still need credentials, field mappings, transformations and provider-specific setup. Review missing information and test your integration with the providers.</p></details>
        </section>
      </div>
    </main>
    <SiteFooter signedIn={Boolean(user)} />
  </>;
}
