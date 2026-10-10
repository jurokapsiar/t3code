import { FACTORY_PROTOCOL_VERSION } from "@t3tools/contracts/factory";

export function isFactoryCompatible(
  capability?: { readonly enabled: boolean; readonly protocolVersion?: number },
  version = FACTORY_PROTOCOL_VERSION,
) {
  return capability?.enabled === true && capability.protocolVersion === version;
}

/** Development pairing changes only the port, never the host or authentication mechanism. */
export function factoryPairUrl(browserOrigin: string, developmentPort?: string) {
  const browser = new URL(browserOrigin);
  if (!["http:", "https:"].includes(browser.protocol) || browser.username || browser.password) {
    throw new TypeError("Use a non-secret HTTP browser origin");
  }
  const target = new URL(browser.origin);
  if (developmentPort !== undefined) {
    if (
      !/^\d+$/.test(developmentPort) ||
      Number(developmentPort) < 1 ||
      Number(developmentPort) > 65535
    ) {
      throw new TypeError("Use a valid canonical factory port");
    }
    target.port = developmentPort;
  }
  return new URL("/pair", target).href;
}
