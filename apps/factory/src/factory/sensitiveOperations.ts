import type { FactoryEnvironmentView } from "@t3tools/contracts/factory";
import type { FactoryEnvironmentEnrollInput } from "@t3tools/contracts/factoryRpc";
import type { FactoryConnectionApi } from "./FactoryConnection";

const safeEnrollmentErrorMessage =
  "The factory could not enroll this source. Check the source credential and try again.";

export interface SerializedSensitiveOperationError {
  readonly name: "SensitiveOperationError";
  readonly message: string;
}

export class SensitiveOperationError extends Error {
  constructor() {
    super(safeEnrollmentErrorMessage);
    this.name = "SensitiveOperationError";
  }

  toJSON(): SerializedSensitiveOperationError {
    return serializeSensitiveOperationError(this);
  }
}

export function serializeSensitiveOperationError(
  _error: unknown,
): SerializedSensitiveOperationError {
  return { name: "SensitiveOperationError", message: safeEnrollmentErrorMessage };
}

export async function enrollSensitiveCredential(
  connection: Pick<FactoryConnectionApi, "request">,
  input: FactoryEnvironmentEnrollInput,
): Promise<FactoryEnvironmentView> {
  try {
    return await connection.request((client) => client["factory.environments.enroll"](input));
  } catch {
    throw new SensitiveOperationError();
  }
}
