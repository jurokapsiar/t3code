import { resolveSourceHttpUrl, type SourceHttpUrlMode } from "@t3tools/contracts/factoryRelayUrl";
export * from "@t3tools/shared/advertisedEndpoint";

export const environmentEndpointUrl = (
  httpBaseUrl: string,
  pathname: string,
  mode?: SourceHttpUrlMode,
): string => {
  if (mode !== undefined) return resolveSourceHttpUrl(httpBaseUrl, pathname, mode);
  const url = new URL(httpBaseUrl);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
};
