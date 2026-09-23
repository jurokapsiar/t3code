import {
  createOpenCodeEnvironmentAtoms,
  openCodeReconcileKey,
  openCodeReconcileKeyAfterResult,
  shouldReconcileOpenCodeThread,
} from "@t3tools/client-runtime/state/opencode";

export { openCodeReconcileKey, openCodeReconcileKeyAfterResult, shouldReconcileOpenCodeThread };

import { connectionAtomRuntime } from "../connection/runtime";

export const openCodeEnvironment = createOpenCodeEnvironmentAtoms(connectionAtomRuntime);
