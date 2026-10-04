import { expect, it } from "@effect/vitest";
import {
  resolveFactoryRelayUrl,
  resolveSourceHttpUrl,
  SourceHttpUrlError,
} from "./factoryRelayUrl.ts";

it("keeps root-relative source requests below their own registration", () => {
  for (const registration of ["registration-a", "registration-b"]) {
    const prefix = `https://factory.test/factory/env/${registration}/`;
    expect(resolveFactoryRelayUrl(prefix, "/api/assets/signed/file.png")).toBe(
      `${prefix}api/assets/signed/file.png`,
    );
    expect(resolveFactoryRelayUrl(prefix, "/api/attachments/upload/payload.signature")).toBe(
      `${prefix}api/attachments/upload/payload.signature`,
    );
    expect(resolveFactoryRelayUrl(prefix, "/api/orchestration/threads/thread/bounded")).toBe(
      `${prefix}api/orchestration/threads/thread/bounded`,
    );
    expect(resolveFactoryRelayUrl(prefix, "/api/projects")).toBe(`${prefix}api/projects`);
  }
});

it.each([
  "https://source.test/api/assets/signed/file.png",
  "//source.test/api/assets/signed/file.png",
  "/api/assets/signed/../file.png",
  "/api/assets/signed/%2e%2e/file.png",
  "/api/assets/signed/%252e%252e/file.png",
  "/api/assets/signed/%2ffile.png",
  "/api/assets/signed/file.png?credential=secret",
  "/api/assets/signed/file.png#hash",
  "/api/auth/session",
  "/api/projects/extra",
  "/api/attachments/upload/token/extra",
  "/api/orchestration/threads/thread/history?cursor=a&cursor=b",
  "/api/assets/signed/\\evil",
])("rejects unsafe or unlisted source path %s", (path) => {
  expect(
    resolveFactoryRelayUrl("https://factory.test/factory/env/registration-a/", path),
  ).toBeNull();
});

it("validates the fixed relay prefix without normalizing traversal", () => {
  for (const prefix of [
    "https://factory.test/",
    "https://factory.test/factory/env/../",
    "https://factory.test/factory/env/%2e%2e/",
    "https://factory.test/factory/env/a%2fb/",
    "https://user:secret@factory.test/factory/env/a/",
    "https://factory.test/factory/env/a/?x=1",
  ]) {
    expect(resolveFactoryRelayUrl(prefix, "/api/projects")).toBeNull();
  }
});

it("preserves ordinary URL behavior and exposes a sanitized typed relay rejection", () => {
  expect(resolveSourceHttpUrl("https://source.test/prefix/", "/api/assets/signed/file.png")).toBe(
    "https://source.test/api/assets/signed/file.png",
  );
  expect(resolveSourceHttpUrl("https://source.test/", "https://other.test/file.png")).toBe(
    "https://other.test/file.png",
  );
  expect(() =>
    resolveSourceHttpUrl(
      "https://factory.test/factory/env/a/",
      "https://source.test/api/assets/secret/file.png",
      { mode: "factory-relay" },
    ),
  ).toThrow(SourceHttpUrlError);
});

it("returns root-relative prefixes and explicit identity proof unchanged by origin", () => {
  expect(
    resolveSourceHttpUrl("/factory/env/a/", "/api/projects", {
      mode: "factory-relay",
      environmentId: "environment-a",
    }),
  ).toBe("/factory/env/a/api/projects?environmentId=environment-a");
  expect(
    resolveFactoryRelayUrl("/factory/env/a/", "/api/orchestration/threads/t/history?cursor=c"),
  ).toBe("/factory/env/a/api/orchestration/threads/t/history?cursor=c");
});
