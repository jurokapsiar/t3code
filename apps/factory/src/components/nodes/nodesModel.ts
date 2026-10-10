import { z } from "zod";
import type { FactoryEnvironmentView } from "@t3tools/contracts/factory";

export interface EnvironmentAddressFields {
  readonly scheme: "http" | "https";
  readonly host: string;
  readonly port: string;
  readonly label: string;
}

export const defaultEnvironmentAddress = {
  scheme: "http",
  host: "127.0.0.1",
  port: "3773",
} satisfies Omit<EnvironmentAddressFields, "label">;

export type EnvironmentDetailsResult =
  | { readonly ok: true; readonly endpoint: string; readonly label: string }
  | { readonly ok: false; readonly error: string };

const environmentAddressSchema = z.object({
  scheme: z.enum(["http", "https"]),
  host: z.string().trim().min(1, "Enter a host."),
  port: z
    .string()
    .trim()
    .regex(/^\d+$/, "Enter a port from 1 to 65535.")
    .transform(Number)
    .pipe(
      z
        .number()
        .int()
        .min(1, "Enter a port from 1 to 65535.")
        .max(65535, "Enter a port from 1 to 65535."),
    ),
  label: z.string().trim().min(1, "Enter a source name."),
});

export type EnvironmentEditResult =
  | {
      readonly ok: true;
      readonly input: {
        readonly registrationId: FactoryEnvironmentView["registrationId"];
        readonly revision: number;
        readonly endpoint: string;
        readonly label: string;
      };
    }
  | { readonly ok: false; readonly error: string };

export function buildEnvironmentDetails(
  fields: EnvironmentAddressFields,
): EnvironmentDetailsResult {
  const parsed = environmentAddressSchema.safeParse(fields);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the source details." };
  }

  let url: URL;
  try {
    url = new URL(parsed.data.scheme + "://" + parsed.data.host + ":" + parsed.data.port);
  } catch {
    return { ok: false, error: "Enter a valid host." };
  }
  if (
    url.hostname.length === 0 ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/"
  ) {
    return { ok: false, error: "Enter a host without a path or credentials." };
  }

  return { ok: true, endpoint: url.origin, label: parsed.data.label };
}

export function buildEnvironmentEdit(
  environment: FactoryEnvironmentView,
  fields: EnvironmentAddressFields,
): EnvironmentEditResult {
  const details = buildEnvironmentDetails(fields);
  if (!details.ok) return details;
  return {
    ok: true,
    input: {
      registrationId: environment.registrationId,
      revision: environment.revision,
      endpoint: environment.credentialStorage === null ? details.endpoint : environment.endpoint,
      label: details.label,
    },
  };
}

export function parseEnvironmentEndpoint(
  endpoint: string,
): Omit<EnvironmentAddressFields, "label"> | null {
  try {
    const url = new URL(endpoint);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return null;
    }
    return {
      scheme: url.protocol === "https:" ? "https" : "http",
      host: url.hostname,
      port: url.port || (url.protocol === "https:" ? "443" : "80"),
    };
  } catch {
    return null;
  }
}

export function environmentStatusMessage(
  environment: Pick<FactoryEnvironmentView, "enabled" | "state">,
): string {
  if (environment.state === "removing")
    return "Removal is pending. The factory is cleaning up this registration.";
  if (environment.state === "pending")
    return "Registration is pending. The factory is connecting to this source.";
  if (environment.state === "blocked")
    return "The factory blocked this source. Retry the connection or re-enroll it.";
  if (!environment.enabled) return "This source is disabled. Enable it to reconnect.";
  if (environment.state === "offline")
    return "This source is offline. The factory will retry the connection.";
  return "This source is online.";
}

export function renewalMessage(
  environment: Pick<FactoryEnvironmentView, "renewal">,
): string | null {
  switch (environment.renewal) {
    case "ready":
      return null;
    case "unsupported":
      return "This source does not support automatic credential renewal. Re-enroll it before expiry.";
    case "due":
      return "Credential renewal is due. The factory will renew it.";
    case "failed":
      return "Credential renewal failed. The current credential may work until it expires.";
    case "expired":
      return "The credential expired. Re-enroll this source to connect again.";
  }
}
