/**
 * A signed token (`signPayload`: `<body>.<mac>`) whose MAC has been tampered
 * with — always different from the genuine one.
 *
 * Overwriting the last two characters with `AA` is not a forgery when the
 * genuine MAC already ends in `AA` (about one run in a thousand, since the MAC
 * covers an expiry that moves with the clock), and the test then fails on a
 * token it was given legitimately. Changing the MAC's first character to a
 * different one changes six significant bits, so the result is always a
 * canonical base64url MAC that does not match.
 */
export function withForgedMac(token: string): string {
  const dot = token.lastIndexOf('.');
  if (dot < 0) throw new Error('not a signed token: no "." separator');
  const mac = token.slice(dot + 1);
  const first = mac.charAt(0) === 'A' ? 'B' : 'A';
  return `${token.slice(0, dot + 1)}${first}${mac.slice(1)}`;
}
