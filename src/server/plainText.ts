/** Control characters other than newline and tab. Written out so the source stays printable. */
const CONTROL_CHAR = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]");
const MARKUP = /[<>]/;
const LINK = /https?:\/\/|www\./i;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
/** A bare domain such as evil.example. A decimal or "e.g." does not match. */
const DOMAIN = /[a-z0-9-]+\.[a-z]{2,}/i;

/** Text bound for a public page, so a manipulated model must not be able to post links or addresses. */
export function isPlainText(s: string): boolean {
  return !CONTROL_CHAR.test(s) && !MARKUP.test(s) && !LINK.test(s) && !EMAIL.test(s) && !DOMAIN.test(s);
}
