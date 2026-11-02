// The OIDC callback address: the server's callback redirects to the app with
// `#oidc_token=…&email=…&nonce=…`. That fragment is credentials, not a place
// the user can be, so it is never a route: it is consumed once on boot and
// the address it rode on is rewritten in place to the same page without it.
import { consumeOidcLogin } from "../../lib/oidc-login";

type Address = Pick<Location, "pathname" | "search" | "hash">;
type LoginStorage = Parameters<typeof consumeOidcLogin>[1];

/** An OIDC callback fragment and the address it rode on, without it. */
export interface AuthFragment {
  fragment: string;
  /** Pathname and search: the page the callback landed on. */
  canonicalUrl: string;
}

/** Reads an OIDC callback fragment from `address`; null when the address
 *  carries none. Pure: no storage, no history. */
export function parseAuthFragment(address: Address): AuthFragment | null {
  if (!address.hash.startsWith("#oidc_token=")) return null;
  return { fragment: address.hash, canonicalUrl: `${address.pathname}${address.search}` };
}

/** Consumes an OIDC callback fragment: the session token (null when the
 *  callback is not for this tab's pending login) and the address to rewrite
 *  the current entry to. Null when `address` carries no callback. The
 *  pending login's nonce is spent either way. */
export function consumeAuthFragment(
  address: Address,
  storage?: LoginStorage,
): { token: string | null; canonicalUrl: string } | null {
  const parsed = parseAuthFragment(address);
  if (parsed === null) return null;
  return { token: consumeOidcLogin(parsed.fragment, storage), canonicalUrl: parsed.canonicalUrl };
}
