import type { FactoryThreadClassification } from "@t3tools/contracts/factory";
import type { BadgeColor } from "../../design-system/actions";

type SessionStatePresentation = {
  label: string;
  color: BadgeColor;
  dot: true;
  pulse?: boolean;
};

const statePresentations: Record<FactoryThreadClassification, SessionStatePresentation> = {
  active: { label: "Active", color: "success", dot: true, pulse: true },
  waiting: { label: "Waiting", color: "warning", dot: true },
  settled: { label: "Settled", color: "neutral", dot: true },
  finished: { label: "Finished", color: "info", dot: true },
  failed: { label: "Failed", color: "danger", dot: true },
  cancelled: { label: "Cancelled", color: "neutral", dot: true },
  idle: { label: "Idle", color: "neutral", dot: true },
  unknown: { label: "Unknown", color: "danger", dot: true },
};

export const getSessionStatePresentation = (
  state: FactoryThreadClassification,
): SessionStatePresentation => statePresentations[state];
