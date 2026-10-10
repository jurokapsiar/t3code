import * as React from "react";
import {
  CounterBadge as HeadlessCounterBadge,
  type CounterBadgeProps as HeadlessCounterBadgeProps,
} from "@fluentui/react-headless-components-preview/badge";
import { cx } from "../../utils/cx";
import styles from "./CounterBadge.module.css";

export type CounterBadgeProps = Omit<HeadlessCounterBadgeProps, "icon"> & {
  icon?: React.ReactNode;
  className?: string;
};
export const CounterBadge = React.forwardRef<HTMLDivElement, CounterBadgeProps>(
  ({ className, icon, ...props }, ref) => (
    <HeadlessCounterBadge
      {...props}
      ref={ref}
      icon={icon == null ? undefined : { children: icon }}
      className={cx(styles.badge, className)}
    />
  ),
);
CounterBadge.displayName = "CounterBadge";
