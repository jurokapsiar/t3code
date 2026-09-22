import {
  createOpenCodeEnvironmentAtoms,
  openCodeReconcileKey,
} from "@t3tools/client-runtime/state/opencode";

export { openCodeReconcileKey };

import { connectionAtomRuntime } from "../connection/runtime";

export const openCodeEnvironment = createOpenCodeEnvironmentAtoms(connectionAtomRuntime);
