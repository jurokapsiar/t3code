import * as React from "react";
import {
  Link as HeadlessLink,
  type LinkProps as HeadlessLinkProps,
} from "@fluentui/react-headless-components-preview/link";
import { cx } from "../../utils/cx";
import styles from "./Link.module.css";

export type LinkProps = HeadlessLinkProps & { className?: string };
export const Link = React.forwardRef<HTMLElement, LinkProps>(({ className, ...props }, ref) => (
  <HeadlessLink {...props} ref={ref} className={cx(styles.link, className)} />
));
Link.displayName = "Link";
