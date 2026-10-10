import {
  Popover as HeadlessPopover,
  PopoverSurface as HeadlessPopoverSurface,
  PopoverTrigger,
} from "@fluentui/react-headless-components-preview/popover";
import { forwardRef } from "react";
import type { ComponentProps } from "react";
import { cx } from "../../utils/cx";
import styles from "./Popover.module.css";

export const Popover = HeadlessPopover;
export { PopoverTrigger };

export type PopoverSurfaceProps = ComponentProps<typeof HeadlessPopoverSurface>;
export const PopoverSurface = forwardRef<HTMLDialogElement | HTMLDivElement, PopoverSurfaceProps>(
  ({ className, ...props }, ref) => (
    <HeadlessPopoverSurface {...props} ref={ref} className={cx(styles.surface, className)} />
  ),
);
PopoverSurface.displayName = "PopoverSurface";
