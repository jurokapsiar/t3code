import * as React from "react";
import {
  ToggleButton as HeadlessToggleButton,
  type ToggleButtonProps as HeadlessToggleButtonProps,
} from "@fluentui/react-headless-components-preview/toggle-button";
import { cx } from "../../utils/cx";
import type { DistributiveOmit } from "../../utils/types";
import type { ButtonAppearance, ButtonSize } from "../Button/Button";
import styles from "./ToggleButton.module.css";

export type ToggleButtonProps = DistributiveOmit<
  HeadlessToggleButtonProps,
  "appearance" | "className" | "icon" | "size"
> & {
  appearance?: ButtonAppearance;
  size?: ButtonSize;
  icon?: React.ReactNode;
  className?: string;
};

export const ToggleButton = React.forwardRef<
  HTMLButtonElement | HTMLAnchorElement,
  ToggleButtonProps
>(({ appearance = "secondary", size = "medium", icon, className, ...props }, ref) => (
  <HeadlessToggleButton
    {...props}
    ref={ref}
    icon={icon == null ? undefined : { children: icon }}
    className={cx(styles.button, className)}
    data-appearance={appearance}
    data-size={size}
  />
));
ToggleButton.displayName = "ToggleButton";
