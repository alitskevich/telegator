/**
 * Messages are sent in Telegram's HTML parse mode, so every interpolated value
 * is escaped, or a `<` or `&` breaks the markup or the send.
 */
export function escapeHtml(text: string): string {
  // `&` first, or the `&lt;` written next would become `&amp;lt;`.
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
