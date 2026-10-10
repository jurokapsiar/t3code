import { Checkbox as HeadlessCheckbox } from "@fluentui/react-headless-components-preview/checkbox";
import { Field as HeadlessField } from "@fluentui/react-headless-components-preview/field";
import { Input as HeadlessInput } from "@fluentui/react-headless-components-preview/input";
import { Label as HeadlessLabel } from "@fluentui/react-headless-components-preview/label";
import {
  Radio,
  RadioGroup as HeadlessRadioGroup,
} from "@fluentui/react-headless-components-preview/radio-group";
import { SearchBox as HeadlessSearchBox } from "@fluentui/react-headless-components-preview/search-box";
import { Select as HeadlessSelect } from "@fluentui/react-headless-components-preview/select";
import { Switch as HeadlessSwitch } from "@fluentui/react-headless-components-preview/switch";
import { Textarea as HeadlessTextarea } from "@fluentui/react-headless-components-preview/textarea";
import { Check, ChevronDown } from "lucide-react";
import { forwardRef, isValidElement } from "react";
import type { ComponentProps } from "react";
import { cx } from "../../utils/cx";
import styles from "./FormControls.module.css";

const withSlotClass = <T,>(slot: T, className: string): T => {
  if (typeof slot === "string" || typeof slot === "number") {
    return { children: slot, className } as T;
  }
  if (slot === null || typeof slot !== "object" || Array.isArray(slot) || isValidElement(slot))
    return slot;
  const slotProps = slot as { className?: string };
  return { ...slotProps, className: cx(className, slotProps.className) } as T;
};

export type FieldProps = ComponentProps<typeof HeadlessField>;
export const Field = forwardRef<HTMLDivElement, FieldProps>(
  ({ className, validationMessage, hint, ...props }, ref) => (
    <HeadlessField
      {...props}
      validationMessage={withSlotClass(validationMessage, styles.validation)}
      hint={withSlotClass(hint, styles.hint)}
      ref={ref}
      className={cx(styles.field, className)}
    />
  ),
);
Field.displayName = "Field";

export type LabelProps = ComponentProps<typeof HeadlessLabel>;
export const Label = forwardRef<HTMLLabelElement, LabelProps>(({ className, ...props }, ref) => (
  <HeadlessLabel {...props} ref={ref} className={cx(styles.label, className)} />
));
Label.displayName = "Label";

export type ControlSize = "small" | "medium" | "large";
type Sized<P> = Omit<P, "size"> & { size?: ControlSize };

export type InputProps = Sized<ComponentProps<typeof HeadlessInput>> & { mono?: boolean };
export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, size = "medium", mono = false, ...props }, ref) => (
    <HeadlessInput
      {...props}
      ref={ref}
      className={cx(styles.input, className)}
      data-size={size}
      data-mono={mono || undefined}
    />
  ),
);
Input.displayName = "Input";

export type TextareaProps = ComponentProps<typeof HeadlessTextarea>;
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => (
    <HeadlessTextarea {...props} ref={ref} className={cx(styles.textarea, className)} />
  ),
);
Textarea.displayName = "Textarea";

export type SelectProps = Sized<ComponentProps<typeof HeadlessSelect>>;
export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, size = "medium", icon, ...props }, ref) => (
    <HeadlessSelect
      {...props}
      ref={ref}
      icon={icon ?? <ChevronDown aria-hidden size={16} />}
      className={cx(styles.select, className)}
      data-size={size}
    />
  ),
);
Select.displayName = "Select";

export type SearchBoxProps = Sized<ComponentProps<typeof HeadlessSearchBox>>;
export const SearchBox = forwardRef<HTMLInputElement, SearchBoxProps>(
  ({ className, size = "medium", ...props }, ref) => (
    <HeadlessSearchBox
      {...props}
      ref={ref}
      className={cx(styles.searchBox, className)}
      data-size={size}
    />
  ),
);
SearchBox.displayName = "SearchBox";

export type CheckboxProps = ComponentProps<typeof HeadlessCheckbox>;
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, indicator, ...props }, ref) => (
    <HeadlessCheckbox
      {...props}
      ref={ref}
      indicator={withSlotClass(
        indicator ?? { children: <Check aria-hidden size={13} strokeWidth={3} /> },
        styles.checkboxIndicator,
      )}
      className={cx(styles.checkbox, className)}
    />
  ),
);
Checkbox.displayName = "Checkbox";

export type SwitchProps = ComponentProps<typeof HeadlessSwitch>;
export const Switch = forwardRef<HTMLInputElement, SwitchProps>(
  ({ className, indicator, ...props }, ref) => (
    <HeadlessSwitch
      {...props}
      ref={ref}
      indicator={withSlotClass(indicator ?? {}, styles.switchIndicator)}
      className={cx(styles.switch, className)}
    />
  ),
);
Switch.displayName = "Switch";

export type RadioGroupLayout = "vertical" | "horizontal" | "cards";
export type RadioGroupProps = Omit<ComponentProps<typeof HeadlessRadioGroup>, "layout"> & {
  layout?: RadioGroupLayout;
};
export const RadioGroup = forwardRef<HTMLDivElement, RadioGroupProps>(
  ({ className, layout = "vertical", ...props }, ref) => (
    <HeadlessRadioGroup
      {...props}
      ref={ref}
      className={cx(styles.radioGroup, className)}
      data-layout={layout}
    />
  ),
);
RadioGroup.displayName = "RadioGroup";

export type RadioProps = ComponentProps<typeof Radio>;
export const StyledRadio = forwardRef<HTMLInputElement, RadioProps>(
  ({ className, indicator, ...props }, ref) => (
    <Radio
      {...props}
      ref={ref}
      indicator={withSlotClass(indicator, styles.radioIndicator)}
      className={cx(styles.radio, className)}
    />
  ),
);
StyledRadio.displayName = "Radio";
