import * as React from "react";
import {
  Card as HeadlessCard,
  CardFooter as HeadlessCardFooter,
  CardHeader as HeadlessCardHeader,
  CardPreview as HeadlessCardPreview,
  type CardProps as HeadlessCardProps,
  type CardFooterProps as HeadlessCardFooterProps,
  type CardHeaderProps as HeadlessCardHeaderProps,
  type CardPreviewProps as HeadlessCardPreviewProps,
} from "@fluentui/react-headless-components-preview/card";
import { cx } from "../../utils/cx";
import styles from "./Card.module.css";

export type CardAppearance = "filled" | "outline" | "subtle";
export type CardTone = "default" | "warning" | "brand";
export type CardProps = HeadlessCardProps & {
  appearance?: CardAppearance;
  tone?: CardTone;
  interactive?: boolean;
  className?: string;
};
export const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ appearance = "filled", tone = "default", interactive = false, className, ...props }, ref) => (
    <HeadlessCard
      {...props}
      ref={ref}
      className={cx(styles.card, className)}
      data-appearance={appearance}
      data-tone={tone}
      data-interactive={interactive || undefined}
    />
  ),
);
Card.displayName = "Card";

export type CardHeaderProps = HeadlessCardHeaderProps & { className?: string };
type StyledSlot = { as?: React.ElementType; className?: string; children?: React.ReactNode };
const isStyledSlot = (value: unknown): value is StyledSlot =>
  typeof value === "object" &&
  value !== null &&
  !React.isValidElement(value) &&
  ("className" in value || "children" in value || "as" in value);
const withSlotClass = (
  slot: HeadlessCardHeaderProps["header"],
  className: string,
): HeadlessCardHeaderProps["header"] => {
  if (slot == null) return slot;
  if (isStyledSlot(slot))
    return Object.assign({}, slot, { className: cx(className, slot.className) });
  return { className, children: slot };
};
export const CardHeader = React.forwardRef<HTMLDivElement, CardHeaderProps>(
  ({ className, header, description, action, ...props }, ref) => (
    <HeadlessCardHeader
      {...props}
      ref={ref}
      header={withSlotClass(header, styles.heading)}
      description={withSlotClass(description, styles.description)}
      action={withSlotClass(action, styles.action)}
      className={cx(styles.header, className)}
    />
  ),
);
CardHeader.displayName = "CardHeader";

export type CardFooterProps = HeadlessCardFooterProps & { className?: string };
export const CardFooter = React.forwardRef<HTMLDivElement, CardFooterProps>(
  ({ className, ...props }, ref) => (
    <HeadlessCardFooter {...props} ref={ref} className={cx(styles.footer, className)} />
  ),
);
CardFooter.displayName = "CardFooter";

export type CardPreviewProps = HeadlessCardPreviewProps & { className?: string };
export const CardPreview = React.forwardRef<HTMLDivElement, CardPreviewProps>(
  ({ className, ...props }, ref) => (
    <HeadlessCardPreview {...props} ref={ref} className={cx(styles.preview, className)} />
  ),
);
CardPreview.displayName = "CardPreview";
