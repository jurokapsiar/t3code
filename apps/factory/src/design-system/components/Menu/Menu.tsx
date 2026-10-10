import {
  Menu as HeadlessMenu,
  MenuDivider as HeadlessMenuDivider,
  MenuGroup as HeadlessMenuGroup,
  MenuGroupHeader as HeadlessMenuGroupHeader,
  MenuItem as HeadlessMenuItem,
  MenuItemCheckbox as HeadlessMenuItemCheckbox,
  MenuItemLink as HeadlessMenuItemLink,
  MenuItemRadio as HeadlessMenuItemRadio,
  MenuItemSwitch as HeadlessMenuItemSwitch,
  MenuList as HeadlessMenuList,
  MenuPopover as HeadlessMenuPopover,
  MenuTrigger,
  MenuSplitGroup as HeadlessMenuSplitGroup,
} from "@fluentui/react-headless-components-preview/menu";
import { forwardRef } from "react";
import type { ComponentProps } from "react";
import { cx } from "../../utils/cx";
import styles from "./Menu.module.css";

export const Menu = HeadlessMenu;
export { MenuTrigger };

export type MenuPopoverProps = ComponentProps<typeof HeadlessMenuPopover>;
export const MenuPopover = forwardRef<HTMLDivElement, MenuPopoverProps>(
  ({ className, ...props }, ref) => (
    <HeadlessMenuPopover {...props} ref={ref} className={cx(styles.popover, className)} />
  ),
);
MenuPopover.displayName = "MenuPopover";

export type MenuListProps = ComponentProps<typeof HeadlessMenuList>;
export const MenuList = forwardRef<HTMLDivElement, MenuListProps>(
  ({ className, ...props }, ref) => (
    <HeadlessMenuList {...props} ref={ref} className={cx(styles.list, className)} />
  ),
);
MenuList.displayName = "MenuList";

export type MenuItemProps = ComponentProps<typeof HeadlessMenuItem>;
export const MenuItem = forwardRef<HTMLDivElement, MenuItemProps>(
  ({ className, ...props }, ref) => (
    <HeadlessMenuItem {...props} ref={ref} className={cx(styles.item, className)} />
  ),
);
MenuItem.displayName = "MenuItem";

export type MenuItemCheckboxProps = ComponentProps<typeof HeadlessMenuItemCheckbox>;
export const MenuItemCheckbox = forwardRef<HTMLDivElement, MenuItemCheckboxProps>(
  ({ className, ...props }, ref) => (
    <HeadlessMenuItemCheckbox
      {...props}
      ref={ref}
      className={cx(styles.item, styles.checkable, className)}
    />
  ),
);
MenuItemCheckbox.displayName = "MenuItemCheckbox";

export type MenuItemRadioProps = ComponentProps<typeof HeadlessMenuItemRadio>;
export const MenuItemRadio = forwardRef<HTMLDivElement, MenuItemRadioProps>(
  ({ className, ...props }, ref) => (
    <HeadlessMenuItemRadio
      {...props}
      ref={ref}
      className={cx(styles.item, styles.checkable, className)}
    />
  ),
);
MenuItemRadio.displayName = "MenuItemRadio";

export type MenuItemLinkProps = ComponentProps<typeof HeadlessMenuItemLink>;
export const MenuItemLink = forwardRef<HTMLAnchorElement, MenuItemLinkProps>(
  ({ className, ...props }, ref) => (
    <HeadlessMenuItemLink
      {...props}
      ref={ref}
      className={cx(styles.item, styles.link, className)}
    />
  ),
);
MenuItemLink.displayName = "MenuItemLink";

export type MenuItemSwitchProps = ComponentProps<typeof HeadlessMenuItemSwitch>;
export const MenuItemSwitch = forwardRef<HTMLDivElement, MenuItemSwitchProps>(
  ({ className, ...props }, ref) => (
    <HeadlessMenuItemSwitch
      {...props}
      ref={ref}
      className={cx(styles.item, styles.checkable, className)}
    />
  ),
);
MenuItemSwitch.displayName = "MenuItemSwitch";

export type MenuDividerProps = ComponentProps<typeof HeadlessMenuDivider>;
export const MenuDivider = forwardRef<HTMLDivElement, MenuDividerProps>(
  ({ className, ...props }, ref) => (
    <HeadlessMenuDivider {...props} ref={ref} className={cx(styles.divider, className)} />
  ),
);
MenuDivider.displayName = "MenuDivider";

export type MenuGroupProps = ComponentProps<typeof HeadlessMenuGroup>;
export const MenuGroup = forwardRef<HTMLDivElement, MenuGroupProps>(
  ({ className, ...props }, ref) => (
    <HeadlessMenuGroup {...props} ref={ref} className={cx(styles.group, className)} />
  ),
);
MenuGroup.displayName = "MenuGroup";

export type MenuGroupHeaderProps = ComponentProps<typeof HeadlessMenuGroupHeader>;
export const MenuGroupHeader = forwardRef<HTMLDivElement, MenuGroupHeaderProps>(
  ({ className, ...props }, ref) => (
    <HeadlessMenuGroupHeader {...props} ref={ref} className={cx(styles.groupHeader, className)} />
  ),
);
MenuGroupHeader.displayName = "MenuGroupHeader";

export type MenuSplitGroupProps = ComponentProps<typeof HeadlessMenuSplitGroup>;
export const MenuSplitGroup = forwardRef<HTMLDivElement, MenuSplitGroupProps>(
  ({ className, ...props }, ref) => (
    <HeadlessMenuSplitGroup {...props} ref={ref} className={cx(styles.group, className)} />
  ),
);
MenuSplitGroup.displayName = "MenuSplitGroup";
