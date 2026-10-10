import {
  Drawer as HeadlessDrawer,
  DrawerBody as HeadlessDrawerBody,
  DrawerFooter as HeadlessDrawerFooter,
  DrawerHeader as HeadlessDrawerHeader,
  DrawerHeaderNavigation as HeadlessDrawerHeaderNavigation,
  DrawerHeaderTitle as HeadlessDrawerHeaderTitle,
  InlineDrawer as HeadlessInlineDrawer,
  OverlayDrawer as HeadlessOverlayDrawer,
} from "@fluentui/react-headless-components-preview/drawer";
import { forwardRef } from "react";
import type { ComponentProps, Ref } from "react";
import { cx } from "../../utils/cx";
import styles from "./Drawer.module.css";

export type DrawerSize = "small" | "medium" | "large" | "full";
type WithSize<P> = P & { size?: DrawerSize };

export type OverlayDrawerProps = WithSize<ComponentProps<typeof HeadlessOverlayDrawer>>;
export const OverlayDrawer = forwardRef<HTMLDialogElement, OverlayDrawerProps>(
  ({ className, size = "medium", position = "start", ...props }, ref) => (
    <HeadlessOverlayDrawer
      {...props}
      ref={ref}
      position={position}
      className={cx(styles.overlay, className)}
      data-size={size}
      data-position={position}
    />
  ),
);
OverlayDrawer.displayName = "OverlayDrawer";

export type InlineDrawerProps = WithSize<ComponentProps<typeof HeadlessInlineDrawer>>;
export const InlineDrawer = forwardRef<HTMLElement, InlineDrawerProps>(
  ({ className, size = "medium", position = "start", ...props }, ref) => (
    <HeadlessInlineDrawer
      {...props}
      ref={ref}
      position={position}
      className={cx(styles.inline, className)}
      data-size={size}
      data-position={position}
    />
  ),
);
InlineDrawer.displayName = "InlineDrawer";

export type DrawerProps = ComponentProps<typeof HeadlessDrawer> & { size?: DrawerSize };
export const Drawer = forwardRef<HTMLElement | HTMLDialogElement, DrawerProps>((props, ref) => {
  if (props.type === "inline") {
    const { type: _type, size, ...inlineProps } = props;
    return <InlineDrawer {...inlineProps} ref={ref as Ref<HTMLElement>} size={size} />;
  }
  const { type: _type, size, ...overlayProps } = props;
  return <OverlayDrawer {...overlayProps} ref={ref as Ref<HTMLDialogElement>} size={size} />;
});
Drawer.displayName = "Drawer";

export type DrawerHeaderProps = ComponentProps<typeof HeadlessDrawerHeader>;
export const DrawerHeader = forwardRef<HTMLElement, DrawerHeaderProps>(
  ({ className, ...props }, ref) => (
    <HeadlessDrawerHeader {...props} ref={ref} className={cx(styles.header, className)} />
  ),
);
DrawerHeader.displayName = "DrawerHeader";

export type DrawerHeaderTitleProps = ComponentProps<typeof HeadlessDrawerHeaderTitle>;
export const DrawerHeaderTitle = forwardRef<HTMLDivElement, DrawerHeaderTitleProps>(
  ({ className, ...props }, ref) => (
    <HeadlessDrawerHeaderTitle {...props} ref={ref} className={cx(styles.headerTitle, className)} />
  ),
);
DrawerHeaderTitle.displayName = "DrawerHeaderTitle";

export type DrawerHeaderNavigationProps = ComponentProps<typeof HeadlessDrawerHeaderNavigation>;
export const DrawerHeaderNavigation = forwardRef<HTMLElement, DrawerHeaderNavigationProps>(
  ({ className, ...props }, ref) => (
    <HeadlessDrawerHeaderNavigation
      {...props}
      ref={ref}
      className={cx(styles.navigation, className)}
    />
  ),
);
DrawerHeaderNavigation.displayName = "DrawerHeaderNavigation";

export type DrawerBodyProps = ComponentProps<typeof HeadlessDrawerBody>;
export const DrawerBody = forwardRef<HTMLDivElement, DrawerBodyProps>(
  ({ className, ...props }, ref) => (
    <HeadlessDrawerBody {...props} ref={ref} className={cx(styles.body, className)} />
  ),
);
DrawerBody.displayName = "DrawerBody";

export type DrawerFooterProps = ComponentProps<typeof HeadlessDrawerFooter>;
export const DrawerFooter = forwardRef<HTMLElement, DrawerFooterProps>(
  ({ className, ...props }, ref) => (
    <HeadlessDrawerFooter {...props} ref={ref} className={cx(styles.footer, className)} />
  ),
);
DrawerFooter.displayName = "DrawerFooter";
