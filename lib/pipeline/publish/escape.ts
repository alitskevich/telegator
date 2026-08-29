/**
 * §3.4 L338 sends with Telegram's HTML parse mode, so every value interpolated
 * into a message must be escaped or Telegram reads it as markup — a summary
 * containing `<` or `&` otherwise yields broken tags or a rejected send. The
 * spec does not state this; it is a recorded correctness decision.
 *
 * One definition, shared by `render.ts` and `assemble.ts`. They previously held
 * identical private copies, which is how one of them later gains a fifth
 * substitution and the other does not — and the two escape the same message.
 */
export function escapeHtml(text: string): string {
  // `&` first. Escaping `<` to `&lt;` before ampersands would let the next
  // replacement turn it into `&amp;lt;`, so every bracket in a summary would
  // reach subscribers as visible mojibake.
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
