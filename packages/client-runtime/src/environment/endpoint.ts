import { resolveSourceHttpUrl, type SourceHttpUrlMode } from "@t3tools/contracts/factoryRelayUrl";
export * from "@t3tools/shared/advertisedEndpoint";

export const environmentEndpointUrl = (
  httpBaseUrl: string,
  pathname: string,
  mode?: SourceHttpUrlMode,
): string => resolveSourceHttpUrl(httpBaseUrl, pathname, mode);
