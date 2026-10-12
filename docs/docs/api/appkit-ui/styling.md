---
sidebar_position: 7
---

# Styling

This guide covers how to style AppKit UI components using CSS variables and theming.

## CSS import

In your main CSS file, import the AppKit UI styles:

```css
@import "@databricks/appkit-ui/styles.css";
```

This provides a default theme for your app using CSS variables.

## Customizing theme

AppKit UI uses CSS variables for theming, supporting both light and dark modes automatically.

### Full variable list

You can customize the theme by overriding CSS variables. See the [CSS variables](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/styles/globals.css) for the full list of variables.

:::warning Important
If you change any variable, you must change it for **both light and dark mode** to ensure consistent appearance across color schemes.
:::

## Color system

AppKit UI uses the OKLCH color space for better perceptual uniformity. The format is:

```
oklch(lightness chroma hue)
```

Where:
- **lightness**: 0-1 (0 = black, 1 = white)
- **chroma**: 0-0.4 (saturation)
- **hue**: 0-360 (color angle)

## Semantic color variables

### Core colors

- `--background` / `--foreground` - Main background and text
- `--card` / `--card-foreground` - Card backgrounds
- `--popover` / `--popover-foreground` - Popover/dropdown backgrounds

### Interactive colors

- `--primary` / `--primary-foreground` - Primary actions
- `--secondary` / `--secondary-foreground` - Secondary actions
- `--muted` / `--muted-foreground` - Muted/disabled states
- `--accent` / `--accent-foreground` - Accent highlights

### Status colors

- `--destructive` / `--destructive-foreground` - Destructive actions
- `--success` / `--success-foreground` - Success states
- `--warning` / `--warning-foreground` - Warning states

### UI elements

- `--border` - Border colors
- `--input` - Input field borders
- `--ring` - Focus ring colors
- `--radius` - Border radius

### Charts

- `--chart-1` through `--chart-5` - Chart color palette

### Sidebar

- `--sidebar-*` - Sidebar-specific colors

## Density

Spacing in cards, buttons, inputs, selects, tabs, tables, dialogs, popovers, alerts, accordions and form fields comes from CSS variables. The default ("comfortable") spacing is roomy. For tighter spacing that lines up with the Databricks product (32px controls, 16px card padding, flat cards, smaller headings), set `data-density="compact"` on the `<html>` element:

```html
<html lang="en" data-density="compact">
```

New apps created from the AppKit template use compact density.

Set the attribute on `<html>` rather than on a wrapper element. Dialogs, popovers, selects and menus render in a portal at the end of `<body>`, so they only pick up a density set on `<html>`. To keep part of a compact page comfortable, set `data-density="comfortable"` on that subtree.

Class names you pass to a component still win over the density values, for example `<Card className="py-2">` or `<Button className="h-10">`.

### Density variables

| Variable | Comfortable | Compact | Used by |
|---|---|---|---|
| `--card-spacing` | `1.5rem` | `1rem` | `Card` padding and gap, `CardHeader`, `CardContent`, `CardFooter` |
| `--card-header-gap` | `0.5rem` | `0.25rem` | `CardHeader` |
| `--card-radius` | `0.75rem` | `0.5rem` | `Card` |
| `--card-shadow` | small shadow | none | `Card` |
| `--control-height` | `2.25rem` | `2rem` | `Button`, `Input`, `SelectTrigger`, `TabsList` |
| `--control-height-sm` | `2rem` | `1.75rem` | `Button size="sm"`, `SelectTrigger size="sm"` |
| `--control-height-lg` | `2.5rem` | `2.25rem` | `Button size="lg"` |
| `--control-padding-x` | `0.75rem` | `0.625rem` | `Input`, `Textarea`, `SelectTrigger` |
| `--button-padding-x` | `1rem` | `0.75rem` | `Button` (default size) |
| `--table-head-height` | `2.5rem` | `2.25rem` | `TableHead` |
| `--table-cell-padding-y` | `0.5rem` | `0.375rem` | `TableCell` |
| `--dialog-padding` | `1.5rem` | `1.25rem` | `DialogContent`, `AlertDialogContent` |
| `--popover-padding` | `1rem` | `0.75rem` | `PopoverContent`, `HoverCardContent` |
| `--alert-padding-x`, `--alert-padding-y` | `1rem`, `0.75rem` | `0.75rem`, `0.625rem` | `Alert` |
| `--accordion-padding-y` | `1rem` | `0.75rem` | `AccordionTrigger`, `AccordionContent` |
| `--field-set-gap`, `--field-group-gap`, `--field-gap` | `1.5rem`, `1.75rem`, `0.75rem` | `1rem`, `1rem`, `0.5rem` | `FieldSet`, `FieldGroup`, `Field` |
| `--heading-1-size` … `--heading-5-size` | `2.25rem` … `1.125rem` | `1.5rem` … `0.9375rem` | Bare `h1`–`h5` elements |
| `--paragraph-line-height` | `1.75rem` | `1.5` | Bare `p` elements |

You can also override any of these variables yourself, for example to tighten only the cards:

```css
:root {
  --card-spacing: 1.25rem;
}
```

## See also

- [API Reference](/docs/api/appkit-ui) - Complete UI components API documentation
