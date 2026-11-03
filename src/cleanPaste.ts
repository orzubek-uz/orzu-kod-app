/**
 * Normalizes mobile-pasted code:
 * - Converts smart double quotes (“”„«»＂) -> "
 * - Converts smart single quotes (‘’‚‹›＇) -> '
 * - Strips zero-width invisible characters (\u200B-\u200D, \uFEFF, \u2060, \u180E)
 * - Replaces non-breaking spaces (\u00A0, \u202F, \u2007) with normal space
 * - Preserves exact indentation and normalizes line breaks to \n
 */
export function sanitizeMobileCode(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\u200B-\u200D\uFEFF\u2060\u180E]/g, '')
    .replace(/[\u00A0\u202F\u2007]/g, ' ')
    .replace(/[\u201C\u201D\u201E\u201F\u00AB\u00BB\uFF02]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2039\u203A\uFF07]/g, "'");
}
