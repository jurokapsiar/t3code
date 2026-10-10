import * as React from "react";
import {
  Tag as HeadlessTag,
  type TagProps as HeadlessTagProps,
} from "@fluentui/react-headless-components-preview/tag";
import {
  TagGroup as HeadlessTagGroup,
  type TagGroupProps as HeadlessTagGroupProps,
} from "@fluentui/react-headless-components-preview/tag-group";
import { cx } from "../../utils/cx";
import styles from "./Tag.module.css";

export type TagAppearance = "neutral" | "brand";
export type TagProps = Omit<HeadlessTagProps, "className" | "icon"> & {
  appearance?: TagAppearance;
  icon?: React.ReactNode;
  className?: string;
};
export const Tag = React.forwardRef<HTMLButtonElement | HTMLSpanElement, TagProps>(
  ({ appearance = "neutral", className, icon, ...props }, ref) => (
    <HeadlessTag
      {...props}
      ref={ref}
      icon={icon == null ? undefined : { children: icon }}
      className={cx(styles.tag, className)}
      data-appearance={appearance}
    />
  ),
);
Tag.displayName = "Tag";
export type TagGroupProps = HeadlessTagGroupProps & { className?: string };
export const TagGroup = React.forwardRef<HTMLDivElement, TagGroupProps>(
  ({ className, ...props }, ref) => (
    <HeadlessTagGroup {...props} ref={ref} className={cx(styles.group, className)} />
  ),
);
TagGroup.displayName = "TagGroup";
