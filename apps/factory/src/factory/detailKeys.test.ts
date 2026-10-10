import { describe, expect, it } from "vite-plus/test";
import { isProtectedSourceQuery, threadDetailKey } from "./queryKeys";

describe("thread detail query keys", () => {
  it("keeps identical thread IDs on different environments separate", () => {
    expect(threadDetailKey("factory", "env-a", "same", "registration-env-a")).not.toEqual(
      threadDetailKey("factory", "env-b", "same", "registration-env-b"),
    );
  });
  it("keeps identical source and thread IDs on different factories separate", () => {
    expect(threadDetailKey("factory-a", "env", "same", "current")).not.toEqual(
      threadDetailKey("factory-b", "env", "same", "current"),
    );
  });

  it("keeps different threads on one environment separate", () => {
    expect(threadDetailKey("factory", "env", "first", "current")).not.toEqual(
      threadDetailKey("factory", "env", "second", "current"),
    );
  });
});

it("isolates two registration identities even when environment and local thread IDs are equal", () => {
  const a = threadDetailKey("factory", "env", "same", "registration-a");
  const b = threadDetailKey("factory", "env", "same", "registration-b");
  expect(a).not.toEqual(b);
  expect(
    isProtectedSourceQuery(a, "factory", {
      registrationId: "registration-a",
      environmentId: "env",
    }),
  ).toBe(true);
  expect(
    isProtectedSourceQuery(b, "factory", {
      registrationId: "registration-a",
      environmentId: "env",
    }),
  ).toBe(false);
});
