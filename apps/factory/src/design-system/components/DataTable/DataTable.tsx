import * as React from "react";
import { ChevronRight } from "lucide-react";
import { Button, type ButtonProps } from "../Button/Button";
import type { DistributiveOmit } from "../../utils/types";
import styles from "./DataTable.module.css";

export type TableProps = React.TableHTMLAttributes<HTMLTableElement>;
export const Table = React.forwardRef<HTMLTableElement, TableProps>(
  ({ className, ...props }, ref) => (
    <table {...props} ref={ref} className={[styles.table, className].filter(Boolean).join(" ")} />
  ),
);
Table.displayName = "Table";
export type TableHeaderProps = React.HTMLAttributes<HTMLTableSectionElement>;
export const TableHeader = React.forwardRef<HTMLTableSectionElement, TableHeaderProps>(
  ({ className, ...props }, ref) => (
    <thead {...props} ref={ref} className={[styles.header, className].filter(Boolean).join(" ")} />
  ),
);
TableHeader.displayName = "TableHeader";
export type TableBodyProps = React.HTMLAttributes<HTMLTableSectionElement>;
export const TableBody = React.forwardRef<HTMLTableSectionElement, TableBodyProps>(
  ({ className, ...props }, ref) => (
    <tbody {...props} ref={ref} className={[styles.body, className].filter(Boolean).join(" ")} />
  ),
);
TableBody.displayName = "TableBody";
export type TableRowProps = React.HTMLAttributes<HTMLTableRowElement> & { "data-level"?: number };
type TableRowStyle = React.CSSProperties & { "--level"?: string };
export const TableRow = React.forwardRef<HTMLTableRowElement, TableRowProps>(
  ({ className, style, "data-level": level = 0, ...props }, ref) => (
    <tr
      {...props}
      ref={ref}
      data-level={level}
      style={{ ...style, "--level": `${level * 20}px` } as TableRowStyle}
      className={[styles.row, className].filter(Boolean).join(" ")}
    />
  ),
);
TableRow.displayName = "TableRow";
export type TableHeaderCellProps = React.ThHTMLAttributes<HTMLTableCellElement>;
export const TableHeaderCell = React.forwardRef<HTMLTableCellElement, TableHeaderCellProps>(
  ({ className, ...props }, ref) => (
    <th {...props} ref={ref} className={[styles.headerCell, className].filter(Boolean).join(" ")} />
  ),
);
TableHeaderCell.displayName = "TableHeaderCell";
export type TableCellProps = React.TdHTMLAttributes<HTMLTableCellElement>;
export const TableCell = React.forwardRef<HTMLTableCellElement, TableCellProps>(
  ({ className, ...props }, ref) => (
    <td {...props} ref={ref} className={[styles.cell, className].filter(Boolean).join(" ")} />
  ),
);
TableCell.displayName = "TableCell";
export type TreeToggleProps = DistributiveOmit<
  ButtonProps,
  "children" | "icon" | "aria-expanded" | "appearance" | "size"
> & { expanded: boolean; "aria-label": string };
export const TreeToggle = React.forwardRef<HTMLButtonElement | HTMLAnchorElement, TreeToggleProps>(
  ({ expanded, className, ...props }, ref) => (
    <Button
      {...props}
      ref={ref}
      appearance="subtle"
      size="small"
      aria-expanded={expanded}
      icon={<ChevronRight aria-hidden="true" />}
      className={[styles.treeToggle, className].filter(Boolean).join(" ")}
    />
  ),
);
TreeToggle.displayName = "TreeToggle";
