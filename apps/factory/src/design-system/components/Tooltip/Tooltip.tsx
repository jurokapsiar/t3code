import * as React from "react";
import {
  Tooltip as HeadlessTooltip,
  type TooltipProps as HeadlessTooltipProps,
} from "@fluentui/react-headless-components-preview/tooltip";
import { cx } from "../../utils/cx";
import styles from "./Tooltip.module.css";

export type TooltipProps = HeadlessTooltipProps & { contentClassName?: string };
const isSlotProps = (value: unknown): value is { className?: string; [key: string]: unknown } =>
  typeof value === "object" &&
  value !== null &&
  !React.isValidElement(value) &&
  ("className" in value || "children" in value || "as" in value);
export const Tooltip = ({ content, contentClassName, ...props }: TooltipProps) => {
  const slot = isSlotProps(content) ? content : { children: content };
  return (
    <HeadlessTooltip
      {...props}
      content={{ ...slot, className: cx(styles.content, slot.className, contentClassName) }}
    />
  );
};
Tooltip.displayName = "Tooltip";
