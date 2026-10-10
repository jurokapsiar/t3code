import * as React from "react";
import {
  Toolbar as HeadlessToolbar,
  ToolbarButton as HeadlessToolbarButton,
  ToolbarDivider as HeadlessToolbarDivider,
  ToolbarGroup as HeadlessToolbarGroup,
  ToolbarRadioButton as HeadlessToolbarRadioButton,
  ToolbarRadioGroup as HeadlessToolbarRadioGroup,
  ToolbarToggleButton as HeadlessToolbarToggleButton,
  type ToolbarProps as HeadlessToolbarProps,
  type ToolbarButtonProps as HeadlessToolbarButtonProps,
  type ToolbarDividerProps as HeadlessToolbarDividerProps,
  type ToolbarGroupProps as HeadlessToolbarGroupProps,
  type ToolbarRadioButtonProps as HeadlessToolbarRadioButtonProps,
  type ToolbarRadioGroupProps as HeadlessToolbarRadioGroupProps,
  type ToolbarToggleButtonProps as HeadlessToolbarToggleButtonProps,
} from "@fluentui/react-headless-components-preview/toolbar";
import { cx } from "../../utils/cx";
import type { DistributiveOmit } from "../../utils/types";
import styles from "./Toolbar.module.css";

export type ToolbarProps = HeadlessToolbarProps & { className?: string };
export const Toolbar = React.forwardRef<HTMLDivElement, ToolbarProps>(
  ({ className, ...props }, ref) => (
    <HeadlessToolbar {...props} ref={ref} className={cx(styles.toolbar, className)} />
  ),
);
Toolbar.displayName = "Toolbar";

type IconProps<P> = P extends unknown
  ? DistributiveOmit<P, "className" | "icon"> & { className?: string; icon?: React.ReactNode }
  : never;
export type ToolbarButtonProps = IconProps<HeadlessToolbarButtonProps>;
export const ToolbarButton = React.forwardRef<
  HTMLButtonElement | HTMLAnchorElement,
  ToolbarButtonProps
>(({ className, icon, ...props }, ref) => (
  <HeadlessToolbarButton
    {...props}
    ref={ref}
    icon={icon == null ? undefined : { children: icon }}
    className={cx(styles.button, className)}
  />
));
ToolbarButton.displayName = "ToolbarButton";

export type ToolbarToggleButtonProps = IconProps<HeadlessToolbarToggleButtonProps>;
export const ToolbarToggleButton = React.forwardRef<
  HTMLButtonElement | HTMLAnchorElement,
  ToolbarToggleButtonProps
>(({ className, icon, ...props }, ref) => (
  <HeadlessToolbarToggleButton
    {...props}
    ref={ref}
    icon={icon == null ? undefined : { children: icon }}
    className={cx(styles.button, className)}
  />
));
ToolbarToggleButton.displayName = "ToolbarToggleButton";

export type ToolbarRadioButtonProps = IconProps<HeadlessToolbarRadioButtonProps>;
export const ToolbarRadioButton = React.forwardRef<
  HTMLButtonElement | HTMLAnchorElement,
  ToolbarRadioButtonProps
>(({ className, icon, ...props }, ref) => (
  <HeadlessToolbarRadioButton
    {...props}
    ref={ref}
    icon={icon == null ? undefined : { children: icon }}
    className={cx(styles.button, className)}
  />
));
ToolbarRadioButton.displayName = "ToolbarRadioButton";

export type ToolbarDividerProps = HeadlessToolbarDividerProps & { className?: string };
export const ToolbarDivider = React.forwardRef<HTMLDivElement, ToolbarDividerProps>(
  ({ className, ...props }, ref) => (
    <HeadlessToolbarDivider {...props} ref={ref} className={cx(styles.divider, className)} />
  ),
);
ToolbarDivider.displayName = "ToolbarDivider";

export type ToolbarGroupProps = HeadlessToolbarGroupProps & { className?: string };
export const ToolbarGroup = React.forwardRef<HTMLDivElement, ToolbarGroupProps>(
  ({ className, ...props }, ref) => (
    <HeadlessToolbarGroup {...props} ref={ref} className={cx(styles.group, className)} />
  ),
);
ToolbarGroup.displayName = "ToolbarGroup";

export type ToolbarRadioGroupProps = HeadlessToolbarRadioGroupProps & { className?: string };
export const ToolbarRadioGroup = React.forwardRef<HTMLDivElement, ToolbarRadioGroupProps>(
  ({ className, ...props }, ref) => (
    <HeadlessToolbarRadioGroup {...props} ref={ref} className={cx(styles.group, className)} />
  ),
);
ToolbarRadioGroup.displayName = "ToolbarRadioGroup";
