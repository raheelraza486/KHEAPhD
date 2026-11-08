export default function SiteFooter({ signedIn }: { signedIn: boolean }) {
  return (
    <footer className="site-footer">
      <div>
        <a className="brand footer-brand" href="/">
          <span className="brand-mark" aria-hidden="true">AR</span>
          <span><strong>Business API Repository</strong><small>API discovery and invoice workflows</small></span>
        </a>
        <p>Find APIs, check how they connect, and generate, validate and send invoices through supported workflows.</p>
      </div>
      <nav aria-label="Footer navigation">
        <a href="/">Home</a>
        <a href="/apis">All APIs</a>
        <a href="/compatibility">Compatibility</a>
        {signedIn && <a href="/compose/pdf-invoice">Invoice workflows</a>}
        <a href="/about">How it works</a>
      </nav>
    </footer>
  );
}
