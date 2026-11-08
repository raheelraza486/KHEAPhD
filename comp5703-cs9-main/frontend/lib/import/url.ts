// Normalising the document URL. It is half the importer's matching key and
// the index for the content hash, so the same document arriving as http vs
// https, with or without a trailing slash,
// or after a redirect must reduce to one string -- otherwise one document
// submitted twice in two spellings duplicates every record it produced.
//
// The query string is PRESERVED on purpose: Peru's ?wsdl is load-bearing.

export function normaliseDocumentUrl(input: string): string {
  const u = new URL(input); // throws on a non-absolute URL; callers guard first

  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();

  // Drop the port when it is the scheme default (80/443).
  if (
    (u.protocol === "http:" && u.port === "80") ||
    (u.protocol === "https:" && u.port === "443")
  ) {
    u.port = "";
  }

  // A fragment never identifies a document.
  u.hash = "";

  // Collapse a lone trailing slash on the path, but never turn "/" into "".
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.replace(/\/+$/, "");
  }

  return u.toString();
}
