import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
  ServerConfig,
} from "@t3tools/contracts";

export const config = (
  id = "env-a",
  batchedReplay: boolean | null = true,
  version = ORCHESTRATION_PROTOCOL_VERSION,
): ServerConfig =>
  ServerConfig.make({
    environment: {
      environmentId: EnvironmentId.make(id),
      label: id,
      platform: { os: "linux", arch: "x64" },
      serverVersion: "test",
      orchestrationProtocolVersion: version,
      capabilities: {
        repositoryIdentity: false,
        ...(batchedReplay === null ? {} : { batchedReplay }),
      },
    },
    auth: {
      policy: "loopback-browser",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["browser-session-cookie", "bearer-access-token"],
      sessionCookieName: "t3_session",
    },
    cwd: "/test",
    keybindingsConfigPath: "/test/keybindings.json",
    keybindings: [],
    issues: [],
    providers: [],
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/test/logs",
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
      otlpLogsEnabled: false,
    },
    settings: DEFAULT_SERVER_SETTINGS,
    shellResumeCompletionMarker: true,
  });
