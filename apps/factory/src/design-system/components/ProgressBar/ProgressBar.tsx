import * as React from "react";
import {
  ProgressBar as HeadlessProgressBar,
  type ProgressBarProps as HeadlessProgressBarProps,
} from "@fluentui/react-headless-components-preview/progress-bar";
import { cx } from "../../utils/cx";
import styles from "./ProgressBar.module.css";

export type ProgressBarProps = HeadlessProgressBarProps & { className?: string };
const isSlotProps = (value: unknown): value is { className?: string; [key: string]: unknown } =>
  typeof value === "object" &&
  value !== null &&
  !React.isValidElement(value) &&
  ("className" in value || "children" in value || "as" in value);
export const ProgressBar = React.forwardRef<HTMLDivElement, ProgressBarProps>(
  ({ className, bar, ...props }, ref) => {
    const slot = isSlotProps(bar) ? bar : { children: bar };
    return (
      <HeadlessProgressBar
        {...props}
        ref={ref}
        className={cx(styles.progress, className)}
        bar={{ ...slot, className: cx(styles.fill, slot.className) }}
      />
    );
  },
);
ProgressBar.displayName = "ProgressBar";
