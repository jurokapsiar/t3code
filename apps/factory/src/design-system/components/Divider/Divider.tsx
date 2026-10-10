import * as React from "react";
import {
  Divider as HeadlessDivider,
  type DividerProps as HeadlessDividerProps,
} from "@fluentui/react-headless-components-preview/divider";
import { cx } from "../../utils/cx";
import styles from "./Divider.module.css";

export type DividerProps = HeadlessDividerProps & { className?: string };
export const Divider = React.forwardRef<HTMLDivElement, DividerProps>(
  ({ className, ...props }, ref) => (
    <HeadlessDivider {...props} ref={ref} className={cx(styles.divider, className)} />
  ),
);
Divider.displayName = "Divider";
