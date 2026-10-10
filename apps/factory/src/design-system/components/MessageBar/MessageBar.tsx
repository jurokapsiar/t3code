import {
  MessageBar as HeadlessMessageBar,
  MessageBarActions as HeadlessMessageBarActions,
  MessageBarBody as HeadlessMessageBarBody,
  MessageBarTitle as HeadlessMessageBarTitle,
} from "@fluentui/react-headless-components-preview/message-bar";
import { forwardRef } from "react";
import type { ComponentProps } from "react";
import { cx } from "../../utils/cx";
import styles from "./MessageBar.module.css";

export type MessageBarProps = ComponentProps<typeof HeadlessMessageBar>;
export const MessageBar = forwardRef<HTMLDivElement, MessageBarProps>(
  ({ className, ...props }, ref) => (
    <HeadlessMessageBar {...props} ref={ref} className={cx(styles.bar, className)} />
  ),
);
MessageBar.displayName = "MessageBar";

export type MessageBarBodyProps = ComponentProps<typeof HeadlessMessageBarBody>;
export const MessageBarBody = forwardRef<HTMLDivElement, MessageBarBodyProps>(
  ({ className, ...props }, ref) => (
    <HeadlessMessageBarBody {...props} ref={ref} className={cx(styles.body, className)} />
  ),
);
MessageBarBody.displayName = "MessageBarBody";

export type MessageBarTitleProps = ComponentProps<typeof HeadlessMessageBarTitle>;
export const MessageBarTitle = forwardRef<HTMLSpanElement, MessageBarTitleProps>(
  ({ className, ...props }, ref) => (
    <HeadlessMessageBarTitle {...props} ref={ref} className={cx(styles.title, className)} />
  ),
);
MessageBarTitle.displayName = "MessageBarTitle";

export type MessageBarActionsProps = ComponentProps<typeof HeadlessMessageBarActions>;
export const MessageBarActions = forwardRef<HTMLDivElement, MessageBarActionsProps>(
  ({ className, ...props }, ref) => (
    <HeadlessMessageBarActions {...props} ref={ref} className={cx(styles.actions, className)} />
  ),
);
MessageBarActions.displayName = "MessageBarActions";
