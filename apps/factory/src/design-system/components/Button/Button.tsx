import * as React from "react";
import {
  Button as HeadlessButton,
  type ButtonProps as HeadlessButtonProps,
} from "@fluentui/react-headless-components-preview/button";
import { cx } from "../../utils/cx";
import type { DistributiveOmit } from "../../utils/types";
import styles from "./Button.module.css";

export type ButtonAppearance = "secondary" | "primary" | "subtle" | "outline" | "transparent";
export type ButtonSize = "small" | "medium" | "large";
export type ButtonProps = DistributiveOmit<
  HeadlessButtonProps,
  "appearance" | "className" | "icon" | "size"
> & {
  appearance?: ButtonAppearance;
  size?: ButtonSize;
  icon?: React.ReactNode;
  className?: string;
};

export const Button = React.forwardRef<HTMLButtonElement | HTMLAnchorElement, ButtonProps>(
  ({ appearance = "secondary", size = "medium", icon, className, ...props }, ref) => (
    <HeadlessButton
      {...props}
      ref={ref}
      icon={icon == null ? undefined : { children: icon }}
      className={cx(styles.button, className)}
      data-appearance={appearance}
      data-size={size}
    />
  ),
);
Button.displayName = "Button";
