// Fetching a user-chosen URL from the server, which holds a Supabase secret
// key and runs in AWS. That is a server-side request forgery primitive unless
// constrained. The gates, in order:
//
//   scheme/port -> resolve -> block private IPs -> connect to the checked IP
//   -> handle redirects manually, re-checking each hop -> size cap -> time cap
//
// The egress rule lives at the call sites: nothing here returns an upstream
// body on the failure path. Errors are fixed reasons, never wrapped upstream
// text.

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

export type FetchRefusal =
  | "bad_scheme"
  | "bad_port"
  | "credentials_in_url"
  | "unresolvable_host"
  | "private_address"
  | "too_many_redirects"
  | "requires_credentials"
  | "too_large"
  | "timeout"
  | "unreachable";

export type FetchOutcome =
  | { ok: true; body: string; finalUrl: string }
  | { ok: false; refusal: FetchRefusal };

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

/** Reserved / private / loopback ranges an outbound fetch must never reach. */
export function isBlockedAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const p = ip.split(".").map(Number);
    if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
    const [a, b] = p;
    if (a === 127) return true;                 // loopback
    if (a === 10) return true;                  // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true;    // private
    if (a === 169 && b === 254) return true;    // link-local (cloud metadata)
    if (a === 0) return true;                    // "this network"
    if (a >= 224) return true;                   // multicast / reserved
    return false;
  }
  if (v === 6) {
    const ip6 = ip.toLowerCase().replace(/^\[|\]$/g, "");
    if (ip6 === "::1" || ip6 === "::") return true;         // loopback / unspecified
    if (ip6.startsWith("fe80")) return true;                 // link-local
    if (/^f[cd]/.test(ip6)) return true;                     // unique-local fc00::/7
    // IPv4-mapped (::ffff:a.b.c.d): re-check the embedded v4 address.
    const mapped = ip6.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]);
    if (ip6.startsWith("::ffff:0:")) return true;
    return false;
  }
  return true; // not a parseable IP -> refuse
}

type UrlCheck =
  | { ok: true; url: URL; address: string; family: 4 | 6 }
  | { ok: false; refusal: FetchRefusal };

/** Scheme, port, credentials, DNS, and the address blocklist -- one hop. */
async function checkUrl(raw: string): Promise<UrlCheck> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, refusal: "unreachable" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, refusal: "bad_scheme" };
  }
  if (url.username || url.password) return { ok: false, refusal: "credentials_in_url" };
  if (url.port && url.port !== "80" && url.port !== "443") {
    return { ok: false, refusal: "bad_port" };
  }

  let records: { address: string; family: number }[];
  try {
    records = await dnsLookup(url.hostname, { all: true });
  } catch {
    return { ok: false, refusal: "unresolvable_host" };
  }
  if (records.length === 0) return { ok: false, refusal: "unresolvable_host" };
  // Every address the host resolves to must pass; refuse on any that fails.
  for (const r of records) {
    if (isBlockedAddress(r.address)) return { ok: false, refusal: "private_address" };
  }
  const chosen = records[0];
  return { ok: true, url, address: chosen.address, family: chosen.family === 6 ? 6 : 4 };
}

/** Pin the socket to the already-checked IP while keeping the hostname for
 *  SNI and certificate validation -- rewriting the URL to the IP would fail
 *  TLS. A short-TTL record cannot swap under us between check and connect. */
function pinnedAgent(address: string, family: 4 | 6): Agent {
  // undici's connector calls lookup with the node dns.lookup signature and,
  // depending on version, expects either (err, address, family) or
  // (err, [{address, family}]). Support both so the socket actually opens.
  const lookup = (
    _hostname: string,
    options: { all?: boolean } | undefined,
    cb: (err: Error | null, address: unknown, family?: number) => void,
  ) => {
    if (options && options.all) cb(null, [{ address, family }]);
    else cb(null, address, family);
  };
  return new Agent({
    // @ts-expect-error undici accepts a lookup function on connect at runtime
    connect: { lookup },
  });
}

async function readCapped(response: Response): Promise<{ body: string } | { tooLarge: true }> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BYTES) return { tooLarge: true };
  const reader = response.body?.getReader();
  if (!reader) return { body: "" };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        return { tooLarge: true };
      }
      chunks.push(value);
    }
  }
  return { body: Buffer.concat(chunks).toString("utf8") };
}

/**
 * Fetch a document safely. On any failure the caller receives a refusal code,
 * never an upstream body -- the reason is mapped to a fixed string at the
 * boundary.
 */
export async function safeFetch(rawUrl: string): Promise<FetchOutcome> {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const checked = await checkUrl(current);
    if (!checked.ok) return { ok: false, refusal: checked.refusal };

    const agent = pinnedAgent(checked.address, checked.family);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = (await undiciFetch(checked.url.toString(), {
        redirect: "manual", // we re-check every hop ourselves
        signal: controller.signal,
        headers: { accept: "application/json, application/yaml, text/yaml, text/xml, application/xml, text/html, */*" },
        dispatcher: agent,
      })) as unknown as Response;
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) return { ok: false, refusal: "unreachable" };
        current = new URL(location, checked.url).toString();
        continue; // next hop re-runs every gate
      }

      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        return { ok: false, refusal: "requires_credentials" };
      }
      if (!response.ok) {
        await response.body?.cancel();
        return { ok: false, refusal: "unreachable" };
      }

      // Keep the deadline active until the body finishes too: a server may
      // send headers immediately, then stall midway through a large document.
      const read = await readCapped(response);
      if ("tooLarge" in read) return { ok: false, refusal: "too_large" };
      return { ok: true, body: read.body, finalUrl: checked.url.toString() };
    } catch (err) {
      if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
        return { ok: false, refusal: "timeout" };
      }
      return { ok: false, refusal: "unreachable" };
    } finally {
      clearTimeout(timer);
      await agent.destroy();
    }
  }
  return { ok: false, refusal: "too_many_redirects" };
}

/** Fixed, user-facing message for each refusal. Never includes upstream text. */
export function refusalMessage(refusal: FetchRefusal): string {
  switch (refusal) {
    case "bad_scheme": return "Only http and https links are supported.";
    case "bad_port": return "Only standard web ports (80 and 443) are supported.";
    case "credentials_in_url": return "Remove the username and password from the link.";
    case "unresolvable_host": return "This address could not be resolved.";
    case "private_address": return "This address is not permitted.";
    case "too_many_redirects": return "This link redirected too many times.";
    case "requires_credentials": return "This document requires a login and cannot be fetched.";
    case "too_large": return "This document is larger than the 5 MB limit.";
    case "timeout": return "This address did not respond in time.";
    default: return "This address could not be read.";
  }
}
