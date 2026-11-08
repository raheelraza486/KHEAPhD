import ApiCategoryCells from "@/components/api-category-cells";
import ProductIcon, { type ProductIconName } from "@/components/product-icon";

type HomeRepositoryToolsProps = { access: "signed-out" | "viewer" | "submitter" };
type StartCardProps = {
  kind: "publish" | "discover" | "build";
  title: string;
  eyebrow: string;
  description: string;
  button: string;
  href: string;
  accessNote?: string;
};

function CardIllustration({ kind }: Pick<StartCardProps, "kind">) {
  const icons: Record<StartCardProps["kind"], ProductIconName> = { publish: "document", discover: "search", build: "workflow" };
  return <div className="landing-card-art" aria-hidden="true">
    <span className="landing-concept-icon"><ProductIcon name={icons[kind]} /></span>
    {kind === "publish" && <div className="landing-document-art">
      <span className="landing-document-shadow" />
      <div className="landing-document-sheet"><i /><i /><i /><span><ProductIcon name="upload" /></span></div>
    </div>}
    {kind === "discover" && <div className="landing-search-art">
      <div className="landing-browser"><div className="landing-browser-bar"><i /><i /><i /></div><div className="landing-browser-body"><span className="landing-browser-search"><ProductIcon name="search" /><i /></span><span className="landing-browser-result"><i /><b /></span><span className="landing-browser-result"><i /><b /></span><span className="landing-browser-result"><i /><b /></span></div></div>
      <span className="landing-art-tile tile-top"><ProductIcon name="document" /></span><span className="landing-art-tile tile-bottom"><ProductIcon name="workflow" /></span>
    </div>}
    {kind === "build" && <div className="landing-workflow-art">
      <svg className="landing-workflow-connectors" viewBox="0 0 210 145"><path d="M38 76h34q12 0 12-12V38q0-12 12-12h28M124 26v62q0 13 13 13h37" /></svg>
      <span className="landing-cube cube-start"><i /><b /><em /></span><span className="landing-cube cube-middle"><i /><b /><em /></span><span className="landing-cube cube-end"><i /><b /><em /></span>
    </div>}
  </div>;
}

function StartCard({ kind, title, eyebrow, description, button, href, accessNote }: StartCardProps) {
  return <article className={`landing-start-card landing-${kind}`}>
    <CardIllustration kind={kind} />
    <h3>{title}</h3><p className="landing-card-eyebrow">{eyebrow}</p>
    <p className="landing-card-description">{description}</p>
    <a className="landing-card-button" href={href} aria-label={accessNote || undefined}>{button}<ProductIcon name="arrow" /></a>
    {accessNote && <span className="sr-only">{accessNote}</span>}
  </article>;
}

export default function HomeRepositoryTools({ access }: HomeRepositoryToolsProps) {
  const discoveryHref = access === "signed-out" ? "/login?next=%2Fdiscovery" : "/discovery";
  const publisherHref = access === "submitter" ? "/submit" : access === "signed-out" ? "/login?next=%2Fsubmit" : "/about";
  const compositionHref = access === "signed-out" ? "/login?next=%2Fworkflows%2Fcreate" : "/workflows/create";

  return <div className="landing-content">
    <section className="landing-hero" aria-labelledby="home-title">
      <h1 id="home-title">Find the right API<br /><span>for your workflow.</span></h1>
      <p>Find APIs for your tasks, check how they connect, and build a workflow.</p>
      <div className="landing-hero-actions">
        <a className="landing-browse-button" href="/apis">Browse the API library<ProductIcon name="arrow" /></a>
        <a className="landing-task-button" href={discoveryHref}>Describe a task to find APIs<ProductIcon name="workflow" /></a>
      </div>
    </section>
    <section className="landing-start" aria-labelledby="home-platform-title">
      <div className="landing-section-heading">
        <div><p className="landing-eyebrow">Get started</p><h2 id="home-platform-title">Choose where to start</h2></div>
        <p>Share an API, find APIs for your task,<br className="landing-desktop-break" /> or connect them in a workflow.</p>
      </div>
      <div className="landing-start-grid">
        <StartCard kind="publish" title="Publish your own API" eyebrow="API Publisher" description="Make your API available to others by adding operations from an OpenAPI document." button="Add your API" href={publisherHref} accessNote={access === "viewer" ? "Add your API — learn about submission access" : undefined} />
        <StartCard kind="discover" title="Find APIs for your task" eyebrow="API Discovery" description="Tell us what you need using text, a diagram or a recording. Find matching APIs for each requirement." button="Find matching APIs" href={discoveryHref} />
        <StartCard kind="build" title="Build an API workflow" eyebrow="API Composition" description="Turn a sequence of tasks into an API chain. Compare possible chains and check the connections between steps." button="Build a workflow" href={compositionHref} />
      </div>
    </section>
    <ApiCategoryCells />
  </div>;
}
