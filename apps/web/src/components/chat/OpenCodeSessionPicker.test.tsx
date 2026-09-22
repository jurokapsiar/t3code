import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { OpenCodeSessionPicker } from "./OpenCodeSessionPicker";
import { formatOpenCodeSessionAge } from "./OpenCodeSessionPicker";

describe("OpenCodeSessionPicker", () => {
  it("formats session age as compact elapsed days", () => {
    expect(formatOpenCodeSessionAge("2025-09-01T00:00:00.000Z", 1_757_462_400_000)).toBe("9d");
  });
  it("offers a new session even when discovery is unavailable", () => {
    const markup = renderToStaticMarkup(
      <OpenCodeSessionPicker
        environmentId={EnvironmentId.make("environment")}
        instanceId={ProviderInstanceId.make("opencode")}
        cwd={null}
        source={{ type: "new" }}
        editable
        onSourceChange={() => undefined}
      />,
    );

    expect(markup).toContain("OpenCode session");
  });

  it("renders a fixed label when editing is disabled", () => {
    const markup = renderToStaticMarkup(
      <OpenCodeSessionPicker
        environmentId={EnvironmentId.make("environment")}
        instanceId={ProviderInstanceId.make("opencode")}
        cwd="/repo"
        source={{ type: "existing", sessionId: "ses_previous" }}
        editable={false}
        onSourceChange={() => undefined}
      />,
    );

    expect(markup).toContain("OpenCode session");
  });
});
