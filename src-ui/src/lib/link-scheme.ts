// The one decision about a link destination in this app.
//
// A destination here is author-supplied: `msg.content` straight off
// `get_session_history`, `skill.body` off disk, and on a research turn the model
// can echo a page it was asked to read — so the scheme decides whether the app
// hands the address to the operating system, and the app is the thing that says
// so. Both markdown renderers ask this module rather than deciding for themselves.
//
// Two rules, which are the same two `react-markdown`'s own `defaultUrlTransform`
// uses, restated so this app can show them:
//
//   1. An address with no scheme is relative and stays a link: `/sessions/42`,
//      `#turn-3`, `//cdn.example.com/a.png`, and `docs?q=a:b`, where the first
//      colon comes after a `?`, a `#` or a `/` and is therefore part of the path.
//   2. A scheme is only ever `http`, `https` or `mailto`. Every other scheme is
//      refused and rendered as inert text beside `REFUSED_LINK_NOTICE` — including
//      `javascript:`, `data:`, `file:`, `vbscript:`, and the `ircs:` and `xmpp:`
//      the library default allowed and this app has no client for.
//
// A refused address is never rewritten: the surface shows what the author wrote,
// and the only thing withheld is the link.

/** The schemes this app will hand to the operating system. */
export const SAFE_LINK_SCHEMES = ['http', 'https', 'mailto'] as const;

/** What a refused destination says about itself. Names no scheme on purpose. */
export const REFUSED_LINK_NOTICE =
  'This address is not a link: Daedalus did not make it clickable.';

export interface AllowedLink {
  allowed: true;
  /** The address exactly as the author wrote it — never rewritten. */
  href: string;
  /** The lower-cased scheme, or null for a relative address. */
  scheme: string | null;
}

export interface RefusedLink {
  allowed: false;
  /** The address exactly as the author wrote it, so the surface can show it. */
  address: string;
  /** The scheme that was refused, or null when there was none to refuse. */
  scheme: string | null;
}

export type LinkVerdict = AllowedLink | RefusedLink;

const SAFE_SCHEME = /^(?:https?|mailto)$/;

/**
 * The scheme an address names, lower-cased, or null when it names none.
 *
 * The relative rule is the library's: the *first* colon is what decides, and a
 * colon that comes after a `/`, a `?` or a `#` is part of a path, a query or a
 * fragment rather than a scheme. Whitespace around the scheme is trimmed because a
 * browser trims it before it reads the scheme, so ` javascript:` is a javascript
 * address and must be judged as one. A tab or newline *inside* the scheme is
 * deliberately not removed: the allowlist match is anchored, so a split scheme
 * fails closed instead of being reassembled into one the app would open.
 */
export function linkScheme(address: string): string | null {
  const colon = address.indexOf(':');
  if (colon === -1) return null;
  const slash = address.indexOf('/');
  const question = address.indexOf('?');
  const hash = address.indexOf('#');
  if (
    (slash !== -1 && colon > slash) ||
    (question !== -1 && colon > question) ||
    (hash !== -1 && colon > hash)
  ) {
    return null;
  }
  return address.slice(0, colon).trim().toLowerCase();
}

/**
 * Whether this app will open the address, and what to render when it will not.
 *
 * A refused verdict is not an error: it is the app stating a decision about
 * author-supplied text, and the surface's job is to show the address rather than
 * to drop it. An address with no scheme *and* nothing in it is refused too, so a
 * library that answers a dropped scheme with `''` can never turn an empty string
 * into `<a href="">` — focusable, and indistinguishable from a working link.
 */
export function projectLink(address: string | null | undefined): LinkVerdict {
  const value = address ?? '';
  const scheme = linkScheme(value);
  if (scheme !== null) {
    return SAFE_SCHEME.test(scheme) ? { allowed: true, href: value, scheme } : { allowed: false, address: value, scheme };
  }
  if (value.trim() === '') return { allowed: false, address: value, scheme: null };
  return { allowed: true, href: value, scheme: null };
}
