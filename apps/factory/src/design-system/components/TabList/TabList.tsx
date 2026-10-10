import * as React from "react";
import {
  Tab as HeadlessTab,
  TabList as HeadlessTabList,
  type TabProps as HeadlessTabProps,
  type TabListProps as HeadlessTabListProps,
} from "@fluentui/react-headless-components-preview/tab-list";
import { cx } from "../../utils/cx";
import type { BadgeColor } from "../Badge";
import styles from "./TabList.module.css";

export type TabAppearance = "underline" | "pill";
export type TabSize = "small" | "medium";
export type TabListProps = Omit<HeadlessTabListProps, "appearance" | "className"> & {
  appearance?: TabAppearance;
  size?: TabSize;
  className?: string;
};
export const TabList = React.forwardRef<HTMLDivElement, TabListProps>(
  ({ appearance = "underline", size = "medium", className, ...props }, ref) => (
    <HeadlessTabList
      {...props}
      ref={ref}
      className={cx(styles.list, className)}
      data-appearance={appearance}
      data-size={size}
    />
  ),
);
TabList.displayName = "TabList";
export type TabProps = Omit<HeadlessTabProps, "className" | "color"> & {
  size?: TabSize;
  color?: BadgeColor;
  className?: string;
};
export const Tab = React.forwardRef<HTMLButtonElement, TabProps>(
  ({ size, color, className, ...props }, ref) => (
    <HeadlessTab
      {...props}
      ref={ref}
      className={cx(styles.tab, className)}
      data-size={size}
      data-color={color}
    />
  ),
);
Tab.displayName = "Tab";
