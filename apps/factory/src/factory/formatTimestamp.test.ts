import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { formatTimestamp } from "./formatTimestamp";

describe("decoded Factory timestamps", () => {
  it("formats DateTime.Utc instead of parsing its diagnostic string", () => {
    const value = Schema.decodeUnknownSync(Schema.toCodecJson(Schema.DateTimeUtc))(
      "2026-10-04T10:00:00.000Z",
    );
    expect(formatTimestamp(value)).toBe(DateTime.toDateUtc(value).toLocaleString());
    expect(formatTimestamp(value)).not.toBe("Invalid Date");
  });
  it("preserves unavailable timestamps", () => expect(formatTimestamp(null)).toBe("Not available"));
});
