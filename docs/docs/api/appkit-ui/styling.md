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

You can customize the theme by overriding CSS variables. Here's the complete list:

```css
@import "@databricks/appkit-ui/styles.css";

:root {
  --radius: 0.625rem;
  --background: oklch(1 0 0);
  --foreground: oklch(0.141 0.005 285.823);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.141 0.005 285.823);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.141 0.005 285.823);
  --primary: oklch(0.21 0.006 285.885);
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.967 0.001 286.375);
  --secondary-foreground: oklch(0.21 0.006 285.885);
  --muted: oklch(0.967 0.001 286.375);
  --muted-foreground: oklch(0.552 0.016 285.938);
  --accent: oklch(0.967 0.001 286.375);
  --accent-foreground: oklch(0.21 0.006 285.885);
  --destructive: oklch(0.577 0.245 27.325);
  --destructive-foreground: oklch(0.985 0 0);
  --success: oklch(0.603 0.135 166.892);
  --success-foreground: oklch(1 0 0);
  --warning: oklch(0.795 0.157 78.748);
  --warning-foreground: oklch(0.199 0.027 238.732);
  --border: oklch(0.92 0.004 286.32);
  --input: oklch(0.92 0.004 286.32);
  --ring: oklch(0.705 0.015 286.067);
  --chart-1: oklch(0.646 0.222 41.116);
  --chart-2: oklch(0.6 0.118 184.704);
  --chart-3: oklch(0.398 0.07 227.392);
  --chart-4: oklch(0.828 0.189 84.429);
  --chart-5: oklch(0.769 0.188 70.08);
  --sidebar: oklch(0.985 0 0);
  --sidebar-foreground: oklch(0.141 0.005 285.823);
  --sidebar-primary: oklch(0.21 0.006 285.885);
  --sidebar-primary-foreground: oklch(0.985 0 0);
  --sidebar-accent: oklch(0.967 0.001 286.375);
  --sidebar-accent-foreground: oklch(0.21 0.006 285.885);
  --sidebar-border: oklch(0.92 0.004 286.32);
  --sidebar-ring: oklch(0.705 0.015 286.067);
}

@media (prefers-color-scheme: dark) {
  :root {
    --background: oklch(0.141 0.005 285.823);
    --foreground: oklch(0.985 0 0);
    --card: oklch(0.21 0.006 285.885);
    --card-foreground: oklch(0.985 0 0);
    --popover: oklch(0.21 0.006 285.885);
    --popover-foreground: oklch(0.985 0 0);
    --primary: oklch(0.92 0.004 286.32);
    --primary-foreground: oklch(0.21 0.006 285.885);
    --secondary: oklch(0.274 0.006 286.033);
    --secondary-foreground: oklch(0.985 0 0);
    --muted: oklch(0.274 0.006 286.033);
    --muted-foreground: oklch(0.705 0.015 286.067);
    --accent: oklch(0.274 0.006 286.033);
    --accent-foreground: oklch(0.985 0 0);
    --destructive: oklch(0.704 0.191 22.216);
    --destructive-foreground: oklch(0.985 0 0);
    --success: oklch(0.67 0.12 167);
    --success-foreground: oklch(1 0 0);
    --warning: oklch(0.83 0.165 85);
    --warning-foreground: oklch(0.199 0.027 238.732);
    --border: oklch(1 0 0 / 10%);
    --input: oklch(1 0 0 / 15%);
    --ring: oklch(0.552 0.016 285.938);
    --chart-1: oklch(0.488 0.243 264.376);
    --chart-2: oklch(0.696 0.17 162.48);
    --chart-3: oklch(0.769 0.188 70.08);
    --chart-4: oklch(0.627 0.265 303.9);
    --chart-5: oklch(0.645 0.246 16.439);
    --sidebar: oklch(0.21 0.006 285.885);
    --sidebar-foreground: oklch(0.985 0 0);
    --sidebar-primary: oklch(0.488 0.243 264.376);
    --sidebar-primary-foreground: oklch(0.985 0 0);
    --sidebar-accent: oklch(0.274 0.006 286.033);
    --sidebar-accent-foreground: oklch(0.985 0 0);
    --sidebar-border: oklch(1 0 0 / 10%);
    --sidebar-ring: oklch(0.552 0.016 285.938);
  }
}
```

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
