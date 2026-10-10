import { describe, expect, it } from "vite-plus/test";
import { shouldUseFactoryFixture } from "./connectionFactory";

describe("factory fixture selection", () => {
  it("enables the fixture only for the exact development flag", () => {
    expect(shouldUseFactoryFixture(true, "1")).toBe(true);
    expect(shouldUseFactoryFixture(true, "true")).toBe(false);
    expect(shouldUseFactoryFixture(false, "1")).toBe(false);
    expect(shouldUseFactoryFixture(false, undefined)).toBe(false);
  });
});
