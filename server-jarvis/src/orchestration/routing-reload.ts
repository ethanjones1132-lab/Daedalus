import { invalidateConfigCache, loadConfig } from "../config";
import { routingDescriptorFingerprint } from "./routing-descriptor";

export interface RoutingReloadOptions {
  configFile?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RoutingReloadAcknowledgement {
  routing_fingerprint: string;
}

/** Evict the short config cache and fingerprint the canonical file projection. */
export function reloadNativeRoutingConfig(
  options: RoutingReloadOptions = {},
): RoutingReloadAcknowledgement {
  invalidateConfigCache();
  const config = options.configFile
    ? loadConfig({ configFile: options.configFile })
    : loadConfig();
  return {
    routing_fingerprint: routingDescriptorFingerprint(config, options.env ?? process.env),
  };
}
