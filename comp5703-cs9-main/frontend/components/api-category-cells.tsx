import type { ApiCategory } from "@/lib/types";

const CATEGORIES: { name: ApiCategory; description: string; icon: string }[] = [
  { name: "Communication", description: "Send and receive business documents.", icon: "M4 7h15m-4-4 4 4-4 4M20 17H5m4-4-4 4 4 4" },
  { name: "Validation", description: "Check document structure and business rules.", icon: "m8 12 3 3 5-6M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z" },
  { name: "Transformation", description: "Convert formats and map document fields.", icon: "M4 4h6v6H4ZM14 14h6v6h-6ZM14 4h6v6m-6-6 6 6M4 14v6h6m-6-6 6 6" },
  { name: "Other", description: "Explore supporting API functions and services.", icon: "M4 4h6v6H4ZM14 4h6v6h-6ZM4 14h6v6H4ZM14 14h6v6h-6Z" },
];

export default function ApiCategoryCells() {
  return <section className="api-type-section" aria-labelledby="api-type-title">
    <div className="api-type-heading">
      <h2 id="api-type-title">Explore by API type</h2>
      <a className="api-type-all" href="/apis">View all API types <span aria-hidden="true">↗</span></a>
    </div>
    <ul className="api-category-cells" aria-label="Browse API categories">
      {CATEGORIES.map(({ name, description, icon }) => <li key={name} className={`api-category-cell category-${name.toLowerCase()}${name === "Communication" ? " has-subcategories" : ""}`}>
        <a className="api-category-main" href={`/apis?category=${name}`} aria-label={`Browse ${name} APIs`}>
          <span className="api-category-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d={icon} /></svg></span>
          <h3>{name}</h3><p>{description}</p>
          <span className="api-category-open" aria-hidden="true">→</span>
        </a>
        {name === "Communication" && <details className="api-category-directions"><summary aria-label="Communication directions">Send / receive</summary><nav className="api-category-children" aria-label="Communication subcategories">
          <a href="/apis?category=Communication&direction=Send">Send<span aria-hidden="true">›</span></a>
          <a href="/apis?category=Communication&direction=Receive">Receive<span aria-hidden="true">›</span></a>
        </nav></details>}
      </li>)}
    </ul>
  </section>;
}
