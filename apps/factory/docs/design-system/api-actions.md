# Actions & display API

Import components and types from `src/design-system/actions.ts` (relative import, e.g. `../../design-system/actions`). Each wrapper forwards the underlying Fluent headless component's remaining documented props, event handlers, ARIA attributes, slots, and refs; `className` is merged with its design-system CSS Module class. Component module entry points use `src/design-system/components/<Name>`.

## Buttons

- **Button** — Visual props: `appearance?: 'secondary' | 'primary' | 'subtle' | 'outline' | 'transparent'` (default `secondary`), `size?: 'small' | 'medium' | 'large'` (default `medium`), `icon?: ReactNode` convenience slot. Headless props include `as`, `disabledFocusable`, `iconPosition`, native button/anchor attributes, and ref; headless `data-icon-only` controls square icon-only sizing. `ButtonAppearance`, `ButtonSize`, `ButtonProps`.
  ` <Button appearance="primary" icon={<Plus />} onClick={create}>New project</Button>`
- **ToggleButton** — Same appearance/size/icon props and defaults as Button; all headless ToggleButton props including `checked`, `defaultChecked`, `isAccessible`, `iconPosition`, disabled and native button/anchor props. `data-checked` styles the checked state. `ToggleButtonProps`.
  `<ToggleButton checked={enabled} onClick={toggle}>Enabled</ToggleButton>`
- **MenuButton** — Same appearance/size/icon props and defaults as Button; headless props including `menuIcon`, `iconPosition`, `disabledFocusable`, `as`, and native button/anchor props. Defaults `menuIcon` to a Lucide chevron. `MenuButtonProps`.
  `<MenuButton appearance="secondary">Actions</MenuButton>`

## Badges

- **Badge** — Visual props: `appearance?: 'filled' | 'tint' | 'outline' | 'ghost'` (default `tint`), `color?: 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info'` (default `neutral`), `size?: 'small' | 'medium'` (default `medium`), `dot?: boolean`, `pulse?: boolean`, `mono?: boolean`, `icon?: ReactNode` slot convenience. `dot` renders a leading decorative status dot; `pulse` animates it except under reduced motion. Headless Badge props/slots and div attributes are forwarded. `BadgeAppearance`, `BadgeColor`, `BadgeSize`, `BadgeProps`.
  `<Badge color="success" dot pulse>Running</Badge>`
- **CounterBadge** — Headless props: `count`, `dot`, `overflowCount`, `showZero`, `icon?: ReactNode` slot convenience, and div attributes. `data-hidden` and `data-dot` are styled; headless `data-overflowed` is forwarded. `CounterBadgeProps`.
  `<CounterBadge count={12} aria-label="12 notifications" />`

## Cards

- **Card** — Visual props: `appearance?: 'filled' | 'outline' | 'subtle'` (default `filled`), `tone?: 'default' | 'warning' | 'brand'` (default `default`), `interactive?: boolean` (default `false`, enables hover lift). Headless Card props include selection (`selected`, `defaultSelected`, `onSelectionChange`, `checkbox`), `disabled`, and `floatingAction`; `data-selected` styles selection. `CardAppearance`, `CardTone`, `CardProps`.
  `<Card appearance="filled" interactive><CardHeader header="Project" /></Card>`
- **CardHeader** — Headless `header`, `description`, `image`, `action` slots, div attributes, and ref; header/action slots participate in the styled header layout. `CardHeaderProps`.
  `<CardHeader header={<strong>Project</strong>} description="3 sessions" action={<Button>Open</Button>} />`
- **CardFooter** — Headless `action` slot, children, div attributes, and ref. `CardFooterProps`.
  `<CardFooter><Button>Open</Button></CardFooter>`
- **CardPreview** — Headless `logo` slot, children, div attributes, and ref. `CardPreviewProps`.
  `<CardPreview><img src={previewUrl} alt="" /></CardPreview>`

## Other actions and status

- **Divider** — Headless `vertical?: boolean`, optional children/content and wrapper slot, div attributes, and ref. `DividerProps`.
  `<Divider>Or</Divider>`
- **Link** — Headless `as`, `disabled`, `disabledFocusable`, `href`, native link props, and ref. `LinkProps`.
  `<Link href="/sessions">View sessions</Link>`
- **Spinner** — Visual `size?: 'small' | 'medium'` (default `medium`); headless `label`, `labelPosition`, `spinner`, `spinnerTail`, `delay`, native root props, and ref. `SpinnerSize`, `SpinnerProps`.
  `<Spinner size="small" label="Loading sessions" />`
- **ProgressBar** — Headless `value`, `max`, `bar` slot, ARIA/native root props, and ref. `ProgressBarProps`.
  `<ProgressBar value={0.6} aria-label="Loading" />`
- **Skeleton** — Headless Skeleton props/context, native root props, children, and ref. `SkeletonProps`.
  `<Skeleton><SkeletonItem style={{ width: '60%' }} /></Skeleton>`
- **SkeletonItem** — Headless shape/size and native div props, children, and ref. `SkeletonItemProps`.
  `<SkeletonItem aria-hidden="true" />`
- **Tooltip** — Headless `content` (required), `relationship` (required), `showDelay`, `hideDelay`, `visible`, `onVisibleChange`, `withArrow`, `positioning`, and trigger props; visual `contentClassName` merges with the inverted-surface styling. `TooltipProps`.
  `<Tooltip content="Open session" relationship="label"><Button aria-label="Open session">Open</Button></Tooltip>`

## Toolbar

- **Toolbar** — Headless `vertical`, checked value control/defaults and callback, ARIA/native div props, ref. `ToolbarProps`.
  `<Toolbar aria-label="Session actions"><ToolbarButton icon={<RefreshCw />} aria-label="Refresh" /></Toolbar>`
- **ToolbarButton** — Headless button props (including `as`, `iconPosition`, `disabledFocusable`, `vertical`); visual icon convenience `icon?: ReactNode`. Uses subtle Button styling. `ToolbarButtonProps`.
  `<ToolbarButton icon={<RefreshCw />} aria-label="Refresh" />`
- **ToolbarToggleButton** — Headless toggle props, `name`, `value`, icon convenience and native button/anchor props. Uses subtle Button styling. `ToolbarToggleButtonProps`.
  `<ToolbarToggleButton name="view" value="tree">Tree</ToolbarToggleButton>`
- **ToolbarRadioButton** — Headless radio button props, `name`, `value`, icon convenience and native button/anchor props. Uses subtle Button styling. `ToolbarRadioButtonProps`.
  `<ToolbarRadioButton name="sort" value="recent">Recent</ToolbarRadioButton>`
- **ToolbarDivider** — Headless divider `vertical`, optional wrapper slot, div props, and ref. `ToolbarDividerProps`.
  `<ToolbarDivider />`
- **ToolbarGroup** — Headless group props, children, div attributes, and ref. `ToolbarGroupProps`.
  `<ToolbarGroup><ToolbarButton>Refresh</ToolbarButton></ToolbarGroup>`
- **ToolbarRadioGroup** — Headless radio-group props, children, div attributes, and ref. `ToolbarRadioGroupProps`.
  `<ToolbarRadioGroup aria-label="Sort"><ToolbarRadioButton name="sort" value="recent">Recent</ToolbarRadioButton></ToolbarRadioGroup>`

## Tabs and tags

- **TabList** — Visual `size?: 'small' | 'medium'` (default `medium`), `appearance?: 'underline' | 'pill'` (default `underline`); headless `vertical`, `disabled`, `selectedValue`, `defaultSelectedValue`, `selectTabOnFocus`, `onTabSelect`, div props, and ref. `TabListProps`.
  `<TabList appearance="pill"><Tab value="files">Files</Tab></TabList>`
- **Tab** — Optional visual `size?: 'small' | 'medium'` overrides the list size; `color?: BadgeColor` applies the badge's semantic text color and a matching selected pill tint/underline. Omit `color` for standard navigation styling. Appearance is configured on TabList. Headless `value`, `disabled`, `icon`, and native props/ref. `TabProps`.
  `<Tab value="files">Files</Tab>`
- **Tag** — Visual `appearance?: 'neutral' | 'brand'` (default `neutral`); headless `dismissible`, `selected`, `icon`, `media`, `primaryText`, `secondaryText`, `dismissIcon`, `value`, disabled and native props/ref. `TagAppearance`, `TagProps` (with `icon?: ReactNode` slot convenience).
  `<Tag appearance="brand">Frontend</Tag>`
- **TagGroup** — Headless group props including `onDismiss`, children, ARIA/native div props, and ref. `TagGroupProps`.
  `<TagGroup aria-label="Project tags"><Tag>Frontend</Tag></TagGroup>`

## Native data table

- **Table** — Native `table` props and ref. `TableProps`.
  `<Table><TableHeader><TableRow><TableHeaderCell>Project</TableHeaderCell></TableRow></TableHeader><TableBody /></Table>`
- **TableHeader** — Native `thead` props and ref (sticky header cells). `TableHeaderProps`.
  `<TableHeader><TableRow><TableHeaderCell>Project</TableHeaderCell></TableRow></TableHeader>`
- **TableBody** — Native `tbody` props and ref. `TableBodyProps`.
  `<TableBody><TableRow><TableCell>Factory</TableCell></TableRow></TableBody>`
- **TableRow** — Native `tr` props/ref plus `data-selected`, `data-level?: number` (drives CSS `--level` tree indentation), `data-kind="group"` styling, and normal `role` passthrough. `TableRowProps`.
  `<TableRow role="row" data-kind="group" data-level={1}>...</TableRow>`
- **TableHeaderCell** — Native `th` props/ref. `TableHeaderCellProps`.
  `<TableHeaderCell scope="col">Project</TableHeaderCell>`
- **TableCell** — Native `td` props/ref. `TableCellProps`.
  `<TableCell>Factory</TableCell>`
- **TreeToggle** — Headless Button props except children/icon/`aria-expanded`; required `expanded` and `aria-label`, uses a rotating chevron. `TreeToggleProps`.
  `<TreeToggle expanded={open} aria-label="Expand project" onClick={toggle} />`
