import { describe, expect, it } from "vite-plus/test";
import { factoryKeys, targetKey, threadDetailKey } from "./queryKeys";

describe("factory query keys", () => {
  it("encodes a target as an unambiguous identity tuple", () => {
    expect(targetKey({ environmentId: "a:b", threadId: "c" })).toBe('["a:b","c"]');
    expect(targetKey({ environmentId: "a:b", threadId: "c" })).not.toBe(
      targetKey({ environmentId: "a", threadId: "b:c" }),
    );
  });

  it("includes the factory identity and full target in query keys", () => {
    expect(
      factoryKeys.thread("factory-1", {
        registrationId: "registration-2",
        environmentId: "environment-2",
        threadId: "thread-3",
      }),
    ).toEqual([
      "factory",
      "factory-1",
      "source",
      "registration-2",
      "environment-2",
      "thread",
      "thread-3",
    ]);
  });

  it("keeps identical thread IDs on different environments separate", () => {
    expect(threadDetailKey("factory", "env-a", "same", "registration-env-a")).not.toEqual(
      threadDetailKey("factory", "env-b", "same", "registration-env-b"),
    );
  });
});
