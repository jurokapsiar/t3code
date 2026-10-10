import * as React from "react";
import {
  Spinner as HeadlessSpinner,
  type SpinnerProps as HeadlessSpinnerProps,
} from "@fluentui/react-headless-components-preview/spinner";
import { cx } from "../../utils/cx";
import styles from "./Spinner.module.css";

export type SpinnerSize = "small" | "medium";
export type SpinnerProps = Omit<HeadlessSpinnerProps, "className" | "size"> & {
  size?: SpinnerSize;
  className?: string;
};
export const Spinner = React.forwardRef<HTMLElement, SpinnerProps>(
  ({ size = "medium", className, ...props }, ref) => (
    <HeadlessSpinner
      {...props}
      ref={ref}
      className={cx(styles.spinner, className)}
      data-size={size}
    />
  ),
);
Spinner.displayName = "Spinner";
