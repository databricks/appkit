---
sidebar_position: 4
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

## See also

- [API Reference](/docs/api/appkit-ui) - Complete UI components API documentation
