/**
 * Express 5 types route and query values as `string | string[]`
 * (path-to-regexp v8 allows repeated params). Every consumer on this server
 * expects a single string, so normalize once at the boundary.
 */
export function str(value: string | string[] | undefined): string {
  if (value === undefined) return "";
  return Array.isArray(value) ? value[0] ?? "" : value;
}