import * as React from "react";
import {
  Badge as HeadlessBadge,
  type BadgeProps as HeadlessBadgeProps,
} from "@fluentui/react-headless-components-preview/badge";
import { cx } from "../../utils/cx";
import styles from "./Badge.module.css";

export type BadgeAppearance = "filled" | "tint" | "outline" | "ghost";
export type BadgeColor = "neutral" | "brand" | "success" | "warning" | "danger" | "info";
export type BadgeSize = "small" | "medium";
export type BadgeProps = Omit<
  HeadlessBadgeProps,
  "appearance" | "className" | "color" | "icon" | "size"
> & {
  appearance?: BadgeAppearance;
  color?: BadgeColor;
  size?: BadgeSize;
  dot?: boolean;
  pulse?: boolean;
  mono?: boolean;
  icon?: React.ReactNode;
  className?: string;
};

export const Badge = React.forwardRef<HTMLDivElement, BadgeProps>(
  (
    {
      appearance = "tint",
      color = "neutral",
      size = "medium",
      dot = false,
      pulse = false,
      mono = false,
      icon,
      className,
      ...props
    },
    ref,
  ) => (
    <HeadlessBadge
      {...props}
      ref={ref}
      icon={icon == null ? undefined : { children: icon }}
      className={cx(styles.badge, className)}
      data-appearance={appearance}
      data-color={color}
      data-size={size}
      data-dot={dot || undefined}
      data-pulse={pulse || undefined}
      data-mono={mono || undefined}
    />
  ),
);
Badge.displayName = "Badge";
