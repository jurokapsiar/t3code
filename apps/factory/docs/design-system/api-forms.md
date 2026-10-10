# Forms & overlays API

Import components from `src/design-system/forms.ts` (relative import, e.g. `../../design-system/forms`). Each component forwards its installed `@fluentui/react-headless-components-preview@0.3.1` props, `className`, and ref where the headless component accepts one. The named `*Props` types are exported alongside the components. Visual additions/overrides are called out below; all other prop and slot types come directly from the headless declarations.

## Dialog

Import path: `src/design-system/forms.ts` (relative import, e.g. `../../design-system/forms`) (`src/design-system/components/Dialog`). `DialogContent` is not exported by the installed headless package and is not provided here; use `DialogBody` for content. `DialogHeader` is also styled and exported.

| Export          | Headless props                                                                                     | Visual props                                                       | One-line use                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `Dialog`        | `open`, `defaultOpen`, `onOpenChange`, `modalType`, `inertTrapFocus`, `unmountOnClose`, `children` | none                                                               | `<Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}><DialogSurface>...</DialogSurface></Dialog>` |
| `DialogTrigger` | single child, `action?: 'open' \| 'close'`, trigger props                                          | none; style its child (for example with the app `Button`)          | `<DialogTrigger><Button>Open</Button></DialogTrigger>`                                                     |
| `DialogSurface` | native dialog root props/slots, `className`, `style`, ref                                          | `size?: 'small' \| 'medium' \| 'large'` (400/560/760px max widths) | `<DialogSurface size="large">...</DialogSurface>`                                                          |
| `DialogHeader`  | header root props/slots, children, ref                                                             | none                                                               | `<DialogHeader><DialogTitle>Delete project?</DialogTitle></DialogHeader>`                                  |
| `DialogTitle`   | heading root props/slots, children, ref                                                            | 20px/28px semibold                                                 | `<DialogTitle>Delete project?</DialogTitle>`                                                               |
| `DialogBody`    | div root props/slots, children, ref                                                                | scrollable padded body                                             | `<DialogBody>Changes cannot be undone.</DialogBody>`                                                       |
| `DialogActions` | div root props/slots, children, ref                                                                | right-aligned action row                                           | `<DialogActions><Button>Cancel</Button><Button>Delete</Button></DialogActions>`                            |

```tsx
<Dialog open={open} onOpenChange={(_, data) => setOpen(data.open)}>
  <DialogTrigger>
    <Button>Delete project</Button>
  </DialogTrigger>
  <DialogSurface size="small">
    <DialogHeader>
      <DialogTitle>Delete this project?</DialogTitle>
    </DialogHeader>
    <DialogBody>This action cannot be undone.</DialogBody>
    <DialogActions>
      <DialogTrigger action="close">
        <Button appearance="secondary">Cancel</Button>
      </DialogTrigger>
      <Button appearance="primary" onClick={deleteProject}>
        Delete
      </Button>
    </DialogActions>
  </DialogSurface>
</Dialog>
```

For a close affordance in the header, use the app `Button` as a compact icon button and wrap it in `<DialogTrigger action="close">`; provide an accessible name such as `aria-label="Close dialog"`. No separate close-button dependency is required.

## Drawers

Import path: `src/design-system/forms.ts` (relative import, e.g. `../../design-system/forms`) (`src/design-system/components/Drawer`). `Drawer` is the visual generic wrapper: use `type='overlay'` (default) for modal/overlay content or `type='inline'` for in-flow content. `OverlayDrawer` and `InlineDrawer` are also directly exported. `size?: 'small' | 'medium' | 'large' | 'full'` is added to each. Overlay widths are 320/480/640px/full; inline widths are 240/320/440px/full. `position='bottom'` is height-oriented, so use a custom height rather than the width size presets.

| Export                   | Headless props                                                                                                                    | Visual props                                         | One-line use                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `Drawer`                 | headless union props: `type?: 'overlay' \| 'inline'`, open/change/modal/unmount/position props (depending on type), children, ref | `size?: 'small' \| 'medium' \| 'large' \| 'full'`    | `<Drawer type="inline" open size="large">...</Drawer>`                                                 |
| `OverlayDrawer`          | `open`, `onOpenChange`, `modalType`, `unmountOnClose`, `position?: 'start' \| 'end' \| 'bottom'`, root props/slots, ref           | `size` above; rounded inner edge and native backdrop | `<OverlayDrawer open={open} onOpenChange={(_, d) => setOpen(d.open)} size="large">...</OverlayDrawer>` |
| `InlineDrawer`           | `open`, `unmountOnClose`, `position?: 'start' \| 'end' \| 'bottom'`, root props/slots, ref                                        | `size` above; 1px border on its open edge            | `<InlineDrawer open={showDetails} size="small">...</InlineDrawer>`                                     |
| `DrawerHeader`           | header root props/slots, children, ref                                                                                            | padded header with divider                           | `<DrawerHeader><DrawerHeaderTitle>Session details</DrawerHeaderTitle></DrawerHeader>`                  |
| `DrawerHeaderTitle`      | `heading`, `action`, div root props/slots, children, ref                                                                          | semibold 20px title layout                           | `<DrawerHeaderTitle>Session details</DrawerHeaderTitle>`                                               |
| `DrawerHeaderNavigation` | nav root props/slots, children, ref                                                                                               | aligned navigation row                               | `<DrawerHeaderNavigation><a href="/sessions">Sessions</a></DrawerHeaderNavigation>`                    |
| `DrawerBody`             | div root props/slots, children, ref                                                                                               | flexible scrollable body                             | `<DrawerBody>Recent session activity</DrawerBody>`                                                     |
| `DrawerFooter`           | footer root props/slots, children, ref                                                                                            | right-aligned footer actions                         | `<DrawerFooter><Button>Done</Button></DrawerFooter>`                                                   |

```tsx
<OverlayDrawer
  open={drawerOpen}
  onOpenChange={(_, data) => setDrawerOpen(data.open)}
  size="medium"
  position="end"
>
  <DrawerHeader>
    <DrawerHeaderTitle>Session details</DrawerHeaderTitle>
  </DrawerHeader>
  <DrawerBody>Files changed in this session</DrawerBody>
  <DrawerFooter>
    <Button onClick={() => setDrawerOpen(false)}>Close</Button>
  </DrawerFooter>
</OverlayDrawer>
```

## Form controls

Import path: `src/design-system/forms.ts` (relative import, e.g. `../../design-system/forms`) (`src/design-system/components/FormControls`).

| Export       | Headless props                                                                                                                                                       | Visual props                                                             | One-line use                                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `Field`      | `label`, `required`, `hint`, `validationMessage`, `validationMessageIcon`, `validationState?: 'none' \| 'success' \| 'warning' \| 'error'`, children, root props/ref | vertical spacing; hint and validation colors follow the validation state | `<Field label="Email" hint="Work address"><Input type="email" /></Field>`                                            |
| `Label`      | native label props, `disabled`, `required` (boolean or custom slot indicator), ref                                                                                   | CAP label typography and required marker color                           | `<Label htmlFor="repo" required>Repository</Label>`                                                                  |
| `Input`      | all headless input/native props, `type`, `value`, `defaultValue`, `onChange`, `contentBefore`, `contentAfter`, input/root slots, ref                                 | `size?: 'small' \| 'medium' \| 'large'` (28/36/44px); `mono?: boolean`   | `<Input size="large" mono contentBefore="$" />`                                                                      |
| `Textarea`   | native textarea props/slots, `value`, `defaultValue`, `onChange`, `resize?: 'vertical' \| 'horizontal' \| 'both' \| 'none'`, ref                                     | CAP border, background, focus and disabled treatment                     | `<Textarea resize="vertical" placeholder="Describe the change" />`                                                   |
| `Select`     | native select props/slots, children, `onChange`, `icon`, ref                                                                                                         | same `size` values/heights as `Input`; native select with chevron        | `<Select value={provider} onChange={(_, d) => setProvider(d.value)}><option value="codex">Codex</option></Select>`   |
| `SearchBox`  | headless search props, `value`, `defaultValue`, `onChange`, `contentBefore`, `contentAfter`, `dismiss`, native input props, ref                                      | same `size` values/heights as `Input`                                    | `<SearchBox size="small" placeholder="Filter sessions" />`                                                           |
| `Checkbox`   | `checked`, `defaultChecked`, `onChange`, `label`, `labelPosition`, `input`/`indicator` slots, disabled/native input props, ref                                       | custom CAP checkbox indicator                                            | `<Checkbox checked={includeFiles} onChange={(_, d) => setIncludeFiles(Boolean(d.checked))} label="Include files" />` |
| `Switch`     | `checked`, `defaultChecked`, `onChange`, `label`, `labelPosition`, `indicator`/`input` slots, disabled/native input props, ref                                       | CAP toggle track and thumb                                               | `<Switch checked={live} onChange={(_, d) => setLive(d.checked)} label="Live updates" />`                             |
| `RadioGroup` | `name`, `value`, `onChange`, `required`, `disabled`, children, ref                                                                                                   | `layout?: 'vertical' \| 'horizontal' \| 'cards'`                         | `<RadioGroup layout="horizontal" value={view} onChange={(_, d) => setView(d.value)}>...</RadioGroup>`                |
| `Radio`      | `value`, `label`, `labelPosition`, `onChange`, input/indicator/root props, disabled, ref                                                                             | selectable-tile treatment when parent layout is `cards`                  | `<Radio value="all" label="All sessions" />`                                                                         |

```tsx
<Field label="Project name" required hint="Shown in the project list" validationState="success">
  <Input
    value={name}
    onChange={(_, data) => setName(data.value)}
    contentBefore={<FolderIcon aria-hidden />}
  />
</Field>
```

```tsx
<Select value={provider} onChange={(_, data) => setProvider(data.value)}>
  <option value="codex">Codex</option>
  <option value="claude">Claude</option>
</Select>
```

`RadioGroup` uses a CSS `data-layout` value for its visual layout; `cards` is entirely a layout treatment of its child `Radio` elements and does not change the headless selection model.

## Menus

Import path: `src/design-system/forms.ts` (relative import, e.g. `../../design-system/forms`) (`src/design-system/components/Menu`). `Menu` and `MenuTrigger` are headless behavior/context components; style the trigger child (for example with the app `Button`). Positioning, controlled/uncontrolled state, and checked-value management remain headless APIs.

| Export             | Headless props                                                                                                                                        | Visual props                                 | One-line use                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `Menu`             | `open`, `defaultOpen`, `onOpenChange`, `positioning`, `checkedValues`, `onCheckedValueChange`, children and headless menu props                       | none                                         | `<Menu positioning="below-end"><MenuTrigger><Button>Actions</Button></MenuTrigger>...</Menu>` |
| `MenuTrigger`      | one child; trigger event/ARIA props                                                                                                                   | none; style its child                        | `<MenuTrigger><Button>Actions</Button></MenuTrigger>`                                         |
| `MenuPopover`      | popover root props/slots, ref                                                                                                                         | floating CAP surface, radius, border, shadow | `<MenuPopover><MenuList>...</MenuList></MenuPopover>`                                         |
| `MenuList`         | list root props/slots, children, checked-value props, ref                                                                                             | vertical item stack                          | `<MenuList><MenuItem>Open</MenuItem></MenuList>`                                              |
| `MenuItem`         | `icon`, `secondaryContent`, `checkmark`, `submenuIndicator`, `subText`/`content`, `hasSubmenu`, `persistOnClick`, `disabled`, children, div props/ref | hover/focus/disabled states                  | `<MenuItem onClick={openProject}>Open project</MenuItem>`                                     |
| `MenuItemCheckbox` | name/value/disabled, checked-value context, children, ref                                                                                             | checked indicator                            | `<MenuItemCheckbox name="show" value="files">Show files</MenuItemCheckbox>`                   |
| `MenuItemRadio`    | name/value/disabled, checked-value context, children, ref                                                                                             | radio checked indicator                      | `<MenuItemRadio name="sort" value="recent">Recently active</MenuItemRadio>`                   |
| `MenuItemLink`     | anchor props including `href`, disabled, children, ref                                                                                                | menu-link item treatment                     | `<MenuItemLink href="/projects">Projects</MenuItemLink>`                                      |
| `MenuItemSwitch`   | name/value/disabled, checked-value context, children, ref                                                                                             | switch-like checked item                     | `<MenuItemSwitch name="view" value="compact">Compact mode</MenuItemSwitch>`                   |
| `MenuDivider`      | divider root props, ref                                                                                                                               | 1px token divider                            | `<MenuDivider />`                                                                             |
| `MenuGroup`        | group root props, children, ref                                                                                                                       | grouped vertical items                       | `<MenuGroup><MenuItem>Rename</MenuItem></MenuGroup>`                                          |
| `MenuGroupHeader`  | group header root props, children, ref                                                                                                                | muted group heading                          | `<MenuGroupHeader>Project</MenuGroupHeader>`                                                  |
| `MenuSplitGroup`   | split-group root props, children, ref                                                                                                                 | grouped menu surface layout                  | `<MenuSplitGroup><MenuItem>Run</MenuItem><MenuItem>More</MenuItem></MenuSplitGroup>`          |

```tsx
<Menu positioning="below-end">
  <MenuTrigger>
    <Button appearance="secondary">Actions</Button>
  </MenuTrigger>
  <MenuPopover>
    <MenuList>
      <MenuItem onClick={openProject}>Open project</MenuItem>
      <MenuDivider />
      <MenuItemCheckbox name="display" value="files">
        Show changed files
      </MenuItemCheckbox>
    </MenuList>
  </MenuPopover>
</Menu>
```

## Popovers

Import path: `src/design-system/forms.ts` (relative import, e.g. `../../design-system/forms`) (`src/design-system/components/Popover`). The headless package positions surfaces using CSS anchor positioning and its positioning props. Current evergreen Chrome, Safari, and Firefox use that native path. The provided headless docs note that older browsers without anchor positioning get static placement unless the application loads a CSS anchor-positioning polyfill before rendering; this group does not add a polyfill dependency or silently substitute a JS positioner.

| Export           | Headless props                                                                                                                                    | Visual props                                        | One-line use                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `Popover`        | `open`, `defaultOpen`, `onOpenChange`, `positioning`, `openOnHover`, `openOnContext`, `mouseLeaveDelay`, `withArrow`, `id`, `trapFocus`, children | none                                                | `<Popover positioning="below-start"><PopoverTrigger><Button>Details</Button></PopoverTrigger>...</Popover>` |
| `PopoverTrigger` | one React element child, trigger props, `disableButtonEnhancement`                                                                                | none; style its child                               | `<PopoverTrigger><Button>Details</Button></PopoverTrigger>`                                                 |
| `PopoverSurface` | dialog/div root props/slots, children, ref                                                                                                        | anchored floating surface, CAP radius/border/shadow | `<PopoverSurface>Additional details</PopoverSurface>`                                                       |

## Message bars

Import path: `src/design-system/forms.ts` (relative import, e.g. `../../design-system/forms`) (`src/design-system/components/MessageBar`).

| Export              | Headless props                                                                                                              | Visual props                               | One-line use                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------- |
| `MessageBar`        | `intent?: 'info' \| 'success' \| 'warning' \| 'error'`, `layout`, `politeness`, `icon`, `bottomReflowSpacer`, children, ref | status soft background/border, 12px radius | `<MessageBar intent="success">...</MessageBar>`                     |
| `MessageBarBody`    | div root props/slots, children, ref                                                                                         | flexible body layout                       | `<MessageBarBody>Connection restored.</MessageBarBody>`             |
| `MessageBarTitle`   | span root props/slots, children, ref                                                                                        | semibold title                             | `<MessageBarTitle>Connected</MessageBarTitle>`                      |
| `MessageBarActions` | div root props/slots, `containerAction`, children, ref                                                                      | aligned action row                         | `<MessageBarActions><Button>Reconnect</Button></MessageBarActions>` |

Type exports include `DialogSurfaceSize`, `DrawerSize`, `ControlSize`, `RadioGroupLayout`, and a named `*Props` type for every wrapped component (except behavior-only `Dialog`, `DialogTrigger`, `Menu`, `MenuTrigger`, `Popover`, and `PopoverTrigger`). These types are the headless prop types extended with the visual additions above.
