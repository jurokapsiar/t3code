import { describe, expect, it } from "vite-plus/test";

import { shouldTrackProjectClones } from "./projectClones";

describe("project clone tracking", () => {
  it("tracks clones only on capable sources outside an embedded Factory chat", () => {
    expect(shouldTrackProjectClones({ projectCloneTracking: true, factoryEmbedded: false })).toBe(
      true,
    );
    // The Factory relay closes the whole chat on environment-wide subscriptions.
    expect(shouldTrackProjectClones({ projectCloneTracking: true, factoryEmbedded: true })).toBe(
      false,
    );
    expect(
      shouldTrackProjectClones({ projectCloneTracking: undefined, factoryEmbedded: false }),
    ).toBe(false);
  });
});
