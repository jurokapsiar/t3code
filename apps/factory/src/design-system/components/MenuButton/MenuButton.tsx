import * as React from "react";
import { ChevronDown } from "lucide-react";
import {
  MenuButton as HeadlessMenuButton,
  type MenuButtonProps as HeadlessMenuButtonProps,
} from "@fluentui/react-headless-components-preview/menu-button";
import { cx } from "../../utils/cx";
import type { DistributiveOmit } from "../../utils/types";
import type { ButtonAppearance, ButtonSize } from "../Button/Button";
import styles from "./MenuButton.module.css";

export type MenuButtonProps = DistributiveOmit<
  HeadlessMenuButtonProps,
  "appearance" | "className" | "icon" | "size"
> & {
  appearance?: ButtonAppearance;
  size?: ButtonSize;
  icon?: React.ReactNode;
  className?: string;
};

export const MenuButton = React.forwardRef<HTMLButtonElement | HTMLAnchorElement, MenuButtonProps>(
  ({ appearance = "secondary", size = "medium", icon, menuIcon, className, ...props }, ref) => (
    <HeadlessMenuButton
      {...props}
      ref={ref}
      icon={icon == null ? undefined : { children: icon }}
      menuIcon={
        menuIcon ?? { className: styles.chevron, children: <ChevronDown aria-hidden="true" /> }
      }
      className={cx(styles.button, className)}
      data-appearance={appearance}
      data-size={size}
    />
  ),
);
MenuButton.displayName = "MenuButton";
