/**
 * The link a QR code carries, and reading the code back out of it.
 *
 * The presenter view encodes the current check-in code into the address, and
 * the check-in form fills the code in from it, so a student scans and types
 * only their own ID. Built and read in one module so the two ends agree on the
 * parameter name by construction rather than by two string literals that could
 * drift.
 *
 * WHAT THIS DOES NOT CHANGE ABOUT SHARING
 *
 * The code was already on the projector in large type, where it can be
 * photographed or texted; putting it in the QR only shortens that. What
 * actually stops a code travelling beyond the room is rotating it, which is
 * planned and not built. When it is, this link needs no change: the presenter
 * simply encodes whichever code is current.
 */

const PARAM = "pin";

/** Longer than anything open_session mints, generous for a TA-typed code. */
export const MAX_PIN_LENGTH = 32;

/** The check-in page, with the code attached when there is one to attach. */
export const checkinUrl = (origin: string, pin?: string | null): string => {
  const base = `${origin.replace(/\/+$/, "")}/`;
  const clean = pin?.trim();
  return clean ? `${base}?${PARAM}=${encodeURIComponent(clean)}` : base;
};

/**
 * The code from an address, or null when there is not a usable one.
 *
 * Uppercased because mark_attendance compares upper(btrim(pin)), so a code
 * typed or scanned in lower case was always valid — showing it in capitals just
 * matches what is on the projector. Anything with whitespace or control
 * characters inside, or absurdly long, is ignored rather than put in the field:
 * this is a value from an address bar, and anybody can type an address.
 */
export const pinFromSearch = (search: string): string | null => {
  const raw = new URLSearchParams(search).get(PARAM);
  if (raw === null) return null;

  const clean = raw.trim().toUpperCase();
  if (clean === "" || clean.length > MAX_PIN_LENGTH) return null;
  // Printable ASCII with no spaces: every code this app issues, and nothing
  // that could smuggle layout or control characters into the form.
  if (!/^[\x21-\x7E]+$/.test(clean)) return null;

  return clean;
};

/**
 * The same query string with the code removed, "" when nothing is left.
 *
 * Used to tidy the address bar once the code has been read. Otherwise it sits
 * in the browser history and survives a refresh, and a code that stopped
 * working an hour ago gets filled in again by a student returning to the tab.
 * Any other parameter is kept.
 */
export const searchWithoutPin = (search: string): string => {
  const params = new URLSearchParams(search);
  params.delete(PARAM);
  const rest = params.toString();
  return rest ? `?${rest}` : "";
};

/**
 * True when the page is open on an address only this computer can reach.
 *
 * The QR encodes the address the presenter view is open on. Opened as
 * localhost — the normal way to run the app while developing — that address,
 * scanned on a phone, means the phone itself, so the scan leads nowhere and
 * autofill looks broken when the code is fine. Deployed, the address is the
 * real site and this is false.
 */
export const isUnreachableFromPhone = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname.endsWith(".localhost") ||
  hostname === "127.0.0.1" ||
  hostname === "::1" ||
  hostname === "[::1]";
