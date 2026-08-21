export function safeImageSrc(src: unknown): string {
  const value = String(src ?? "");
  if (/^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[^\s"'<>]*)?$/i.test(value)) return value;
  const match = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/]*={0,2})$/i.exec(value);
  if (!match || !match[1] || match[1].length % 4 !== 0) return "";
  return value;
}
