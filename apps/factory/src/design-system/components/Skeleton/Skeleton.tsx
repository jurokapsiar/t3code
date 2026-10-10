import * as React from "react";
import {
  Skeleton as HeadlessSkeleton,
  SkeletonItem as HeadlessSkeletonItem,
  type SkeletonProps as HeadlessSkeletonProps,
  type SkeletonItemProps as HeadlessSkeletonItemProps,
} from "@fluentui/react-headless-components-preview/skeleton";
import { cx } from "../../utils/cx";
import styles from "./Skeleton.module.css";

export type SkeletonProps = HeadlessSkeletonProps & { className?: string };
export const Skeleton = React.forwardRef<HTMLDivElement, SkeletonProps>(
  ({ className, ...props }, ref) => (
    <HeadlessSkeleton {...props} ref={ref} className={cx(styles.skeleton, className)} />
  ),
);
Skeleton.displayName = "Skeleton";
export type SkeletonItemProps = HeadlessSkeletonItemProps & { className?: string };
export const SkeletonItem = React.forwardRef<HTMLDivElement, SkeletonItemProps>(
  ({ className, ...props }, ref) => (
    <HeadlessSkeletonItem {...props} ref={ref} className={cx(styles.item, className)} />
  ),
);
SkeletonItem.displayName = "SkeletonItem";
