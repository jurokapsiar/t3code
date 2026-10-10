import * as DateTime from "effect/DateTime";

export function formatTimestamp(value: DateTime.Utc | null): string {
  return value === null ? "Not available" : DateTime.toDateUtc(value).toLocaleString();
}
