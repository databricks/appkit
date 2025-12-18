# @databricks/app-kit-ui

## Interfaces

| Interface | Description |
| ------ | ------ |
| [AreaChartSpecificProps](interfaces/AreaChartSpecificProps.md) | Props specific to area charts |
| [BarChartSpecificProps](interfaces/BarChartSpecificProps.md) | Props specific to bar charts |
| [BaseChartProps](interfaces/BaseChartProps.md) | - |
| [CartesianContext](interfaces/CartesianContext.md) | - |
| [ChartBaseProps](interfaces/ChartBaseProps.md) | Common visual and behavior props for all charts |
| [DataProps](interfaces/DataProps.md) | Props for direct data injection |
| [HeatmapChartSpecificProps](interfaces/HeatmapChartSpecificProps.md) | Props specific to heatmap charts |
| [HeatmapContext](interfaces/HeatmapContext.md) | - |
| [LineChartSpecificProps](interfaces/LineChartSpecificProps.md) | Props specific to line charts |
| [NormalizedChartData](interfaces/NormalizedChartData.md) | Normalized chart data for rendering (standard charts) |
| [NormalizedChartDataBase](interfaces/NormalizedChartDataBase.md) | Base normalized data shared by all chart types |
| [NormalizedHeatmapData](interfaces/NormalizedHeatmapData.md) | Normalized data for heatmap charts. Extends base (not NormalizedChartData) because heatmaps don't use yDataMap. Instead, they use heatmapData which contains [xIndex, yIndex, value] tuples. |
| [OptionBuilderContext](interfaces/OptionBuilderContext.md) | - |
| [PieChartSpecificProps](interfaces/PieChartSpecificProps.md) | Props specific to pie/donut charts |
| [PluginRegistry](interfaces/PluginRegistry.md) | - |
| [QueryProps](interfaces/QueryProps.md) | Props for query-based data fetching |
| [QueryRegistry](interfaces/QueryRegistry.md) | Query Registry for type-safe analytics queries. Extend this interface via module augmentation to get full type inference: |
| [RadarChartSpecificProps](interfaces/RadarChartSpecificProps.md) | Props specific to radar charts |
| [ScatterChartSpecificProps](interfaces/ScatterChartSpecificProps.md) | Props specific to scatter charts |
| [TypedArrowTable](interfaces/TypedArrowTable.md) | Typed Arrow Table - preserves row type information for type inference. At runtime this is just a regular Arrow Table, but TypeScript knows the row schema. |
| [UseAnalyticsQueryOptions](interfaces/UseAnalyticsQueryOptions.md) | Options for configuring an analytics SSE query |
| [UseAnalyticsQueryResult](interfaces/UseAnalyticsQueryResult.md) | Result state returned by useAnalyticsQuery |
| [UseChartDataOptions](interfaces/UseChartDataOptions.md) | - |
| [UseChartDataResult](interfaces/UseChartDataResult.md) | - |

## Type Aliases

| Type Alias | Description |
| ------ | ------ |
| [AnalyticsFormat](type-aliases/AnalyticsFormat.md) | Supported response formats for analytics queries |
| [AreaChartProps](type-aliases/AreaChartProps.md) | - |
| [BarChartProps](type-aliases/BarChartProps.md) | - |
| [CarouselApi](type-aliases/CarouselApi.md) | - |
| [ChartColorPalette](type-aliases/ChartColorPalette.md) | Color palette types for different visualization needs |
| [ChartConfig](type-aliases/ChartConfig.md) | - |
| [ChartData](type-aliases/ChartData.md) | Data that can be passed to unified charts |
| [ChartType](type-aliases/ChartType.md) | Supported chart types |
| [ChartWrapperProps](type-aliases/ChartWrapperProps.md) | - |
| [DataFormat](type-aliases/DataFormat.md) | Supported data formats for analytics queries |
| [DonutChartProps](type-aliases/DonutChartProps.md) | - |
| [HeatmapChartProps](type-aliases/HeatmapChartProps.md) | - |
| [InferResultByFormat](type-aliases/InferResultByFormat.md) | Conditionally infers result type based on format. - JSON format: Returns the typed array from QueryRegistry - ARROW format: Returns TypedArrowTable with row type preserved |
| [InferRowType](type-aliases/InferRowType.md) | Infers the row type from a query result array. Used for TypedArrowTable row typing. |
| [LineChartProps](type-aliases/LineChartProps.md) | - |
| [Orientation](type-aliases/Orientation.md) | Chart orientation |
| [PieChartProps](type-aliases/PieChartProps.md) | - |
| [RadarChartProps](type-aliases/RadarChartProps.md) | - |
| [ScatterChartProps](type-aliases/ScatterChartProps.md) | - |
| [UnifiedChartProps](type-aliases/UnifiedChartProps.md) | Base union type - either query-based or data-based |

## Variables

| Variable | Description |
| ------ | ------ |
| [AreaChart](variables/AreaChart.md) | Area Chart component. Supports both JSON and Arrow data formats with automatic format selection. |
| [badgeVariants](variables/badgeVariants.md) | - |
| [BarChart](variables/BarChart.md) | Bar Chart component. Supports both JSON and Arrow data formats with automatic format selection. |
| [buttonGroupVariants](variables/buttonGroupVariants.md) | - |
| [buttonVariants](variables/buttonVariants.md) | - |
| [CHART\_COLOR\_VARS](variables/CHART_COLOR_VARS.md) | Legacy: CSS variable names for chart colors (aliases to categorical) |
| [CHART\_COLOR\_VARS\_CATEGORICAL](variables/CHART_COLOR_VARS_CATEGORICAL.md) | CSS variable names for categorical chart colors (distinct categories) |
| [CHART\_COLOR\_VARS\_DIVERGING](variables/CHART_COLOR_VARS_DIVERGING.md) | CSS variable names for diverging chart colors (negative ↔ positive) |
| [CHART\_COLOR\_VARS\_SEQUENTIAL](variables/CHART_COLOR_VARS_SEQUENTIAL.md) | CSS variable names for sequential chart colors (low → high) |
| [ChartLegend](variables/ChartLegend.md) | - |
| [ChartTooltip](variables/ChartTooltip.md) | - |
| [DATE\_FIELD\_PATTERNS](variables/DATE_FIELD_PATTERNS.md) | Field patterns to detect date/time fields by name |
| [DonutChart](variables/DonutChart.md) | Donut Chart component (Pie chart with inner radius). Supports both JSON and Arrow data formats with automatic format selection. |
| [FALLBACK\_COLORS](variables/FALLBACK_COLORS.md) | Legacy: Fallback colors (aliases to categorical) |
| [FALLBACK\_COLORS\_CATEGORICAL](variables/FALLBACK_COLORS_CATEGORICAL.md) | Fallback categorical colors |
| [FALLBACK\_COLORS\_DIVERGING](variables/FALLBACK_COLORS_DIVERGING.md) | Fallback diverging colors (blue → red) |
| [FALLBACK\_COLORS\_SEQUENTIAL](variables/FALLBACK_COLORS_SEQUENTIAL.md) | Fallback sequential colors (light → dark blue) |
| [Form](variables/Form.md) | - |
| [HeatmapChart](variables/HeatmapChart.md) | Heatmap Chart component. Supports both JSON and Arrow data formats with automatic format selection. |
| [LineChart](variables/LineChart.md) | Line Chart component. Supports both JSON and Arrow data formats with automatic format selection. |
| [METADATA\_DATE\_PATTERNS](variables/METADATA_DATE_PATTERNS.md) | Patterns that indicate a date field is metadata, not for charting |
| [NAME\_FIELD\_PATTERNS](variables/NAME_FIELD_PATTERNS.md) | Field patterns to detect name/category fields by name |
| [navigationMenuTriggerStyle](variables/navigationMenuTriggerStyle.md) | - |
| [PieChart](variables/PieChart.md) | Pie Chart component. Supports both JSON and Arrow data formats with automatic format selection. |
| [RadarChart](variables/RadarChart.md) | Radar Chart component. Supports both JSON and Arrow data formats with automatic format selection. |
| [ScatterChart](variables/ScatterChart.md) | Scatter Chart component. Supports both JSON and Arrow data formats with automatic format selection. |
| [toggleVariants](variables/toggleVariants.md) | - |

## Functions

| Function | Description |
| ------ | ------ |
| [Accordion](functions/Accordion.md) | - |
| [AccordionContent](functions/AccordionContent.md) | - |
| [AccordionItem](functions/AccordionItem.md) | - |
| [AccordionTrigger](functions/AccordionTrigger.md) | - |
| [Alert](functions/Alert.md) | - |
| [AlertDescription](functions/AlertDescription.md) | - |
| [AlertDialog](functions/AlertDialog.md) | - |
| [AlertDialogAction](functions/AlertDialogAction.md) | - |
| [AlertDialogCancel](functions/AlertDialogCancel.md) | - |
| [AlertDialogContent](functions/AlertDialogContent.md) | - |
| [AlertDialogDescription](functions/AlertDialogDescription.md) | - |
| [AlertDialogFooter](functions/AlertDialogFooter.md) | - |
| [AlertDialogHeader](functions/AlertDialogHeader.md) | - |
| [AlertDialogOverlay](functions/AlertDialogOverlay.md) | - |
| [AlertDialogPortal](functions/AlertDialogPortal.md) | - |
| [AlertDialogTitle](functions/AlertDialogTitle.md) | - |
| [AlertDialogTrigger](functions/AlertDialogTrigger.md) | - |
| [AlertTitle](functions/AlertTitle.md) | - |
| [AspectRatio](functions/AspectRatio.md) | - |
| [Avatar](functions/Avatar.md) | - |
| [AvatarFallback](functions/AvatarFallback.md) | - |
| [AvatarImage](functions/AvatarImage.md) | - |
| [Badge](functions/Badge.md) | - |
| [BaseChart](functions/BaseChart.md) | Base chart component that handles both Arrow and JSON data. Renders using ECharts for consistent output across both formats. |
| [Breadcrumb](functions/Breadcrumb.md) | - |
| [BreadcrumbEllipsis](functions/BreadcrumbEllipsis.md) | - |
| [BreadcrumbItem](functions/BreadcrumbItem.md) | - |
| [BreadcrumbLink](functions/BreadcrumbLink.md) | - |
| [BreadcrumbList](functions/BreadcrumbList.md) | - |
| [BreadcrumbPage](functions/BreadcrumbPage.md) | - |
| [BreadcrumbSeparator](functions/BreadcrumbSeparator.md) | - |
| [buildCartesianOption](functions/buildCartesianOption.md) | - |
| [buildHeatmapOption](functions/buildHeatmapOption.md) | - |
| [buildHorizontalBarOption](functions/buildHorizontalBarOption.md) | - |
| [buildPieOption](functions/buildPieOption.md) | - |
| [buildRadarOption](functions/buildRadarOption.md) | - |
| [Button](functions/Button.md) | - |
| [ButtonGroup](functions/ButtonGroup.md) | - |
| [ButtonGroupSeparator](functions/ButtonGroupSeparator.md) | - |
| [ButtonGroupText](functions/ButtonGroupText.md) | - |
| [Calendar](functions/Calendar.md) | - |
| [CalendarDayButton](functions/CalendarDayButton.md) | - |
| [Card](functions/Card.md) | - |
| [CardAction](functions/CardAction.md) | - |
| [CardContent](functions/CardContent.md) | - |
| [CardDescription](functions/CardDescription.md) | - |
| [CardFooter](functions/CardFooter.md) | - |
| [CardHeader](functions/CardHeader.md) | - |
| [CardTitle](functions/CardTitle.md) | - |
| [Carousel](functions/Carousel.md) | - |
| [CarouselContent](functions/CarouselContent.md) | - |
| [CarouselItem](functions/CarouselItem.md) | - |
| [CarouselNext](functions/CarouselNext.md) | - |
| [CarouselPrevious](functions/CarouselPrevious.md) | - |
| [ChartContainer](functions/ChartContainer.md) | - |
| [ChartLegendContent](functions/ChartLegendContent.md) | - |
| [ChartStyle](functions/ChartStyle.md) | - |
| [ChartTooltipContent](functions/ChartTooltipContent.md) | - |
| [ChartWrapper](functions/ChartWrapper.md) | Wrapper component for charts. Handles data fetching (query mode) or direct data injection (data mode). |
| [Checkbox](functions/Checkbox.md) | - |
| [Collapsible](functions/Collapsible.md) | - |
| [CollapsibleContent](functions/CollapsibleContent.md) | - |
| [CollapsibleTrigger](functions/CollapsibleTrigger.md) | - |
| [Command](functions/Command.md) | - |
| [CommandDialog](functions/CommandDialog.md) | - |
| [CommandEmpty](functions/CommandEmpty.md) | - |
| [CommandGroup](functions/CommandGroup.md) | - |
| [CommandInput](functions/CommandInput.md) | - |
| [CommandItem](functions/CommandItem.md) | - |
| [CommandList](functions/CommandList.md) | - |
| [CommandSeparator](functions/CommandSeparator.md) | - |
| [CommandShortcut](functions/CommandShortcut.md) | - |
| [ContextMenu](functions/ContextMenu.md) | - |
| [ContextMenuCheckboxItem](functions/ContextMenuCheckboxItem.md) | - |
| [ContextMenuContent](functions/ContextMenuContent.md) | - |
| [ContextMenuGroup](functions/ContextMenuGroup.md) | - |
| [ContextMenuItem](functions/ContextMenuItem.md) | - |
| [ContextMenuLabel](functions/ContextMenuLabel.md) | - |
| [ContextMenuPortal](functions/ContextMenuPortal.md) | - |
| [ContextMenuRadioGroup](functions/ContextMenuRadioGroup.md) | - |
| [ContextMenuRadioItem](functions/ContextMenuRadioItem.md) | - |
| [ContextMenuSeparator](functions/ContextMenuSeparator.md) | - |
| [ContextMenuShortcut](functions/ContextMenuShortcut.md) | - |
| [ContextMenuSub](functions/ContextMenuSub.md) | - |
| [ContextMenuSubContent](functions/ContextMenuSubContent.md) | - |
| [ContextMenuSubTrigger](functions/ContextMenuSubTrigger.md) | - |
| [ContextMenuTrigger](functions/ContextMenuTrigger.md) | - |
| [createChart](functions/createChart.md) | Factory function to create chart components. Eliminates boilerplate by generating components with the same pattern. |
| [createTimeSeriesData](functions/createTimeSeriesData.md) | Creates time-series data pairs for ECharts. |
| [DataTable](functions/DataTable.md) | Production-ready data table with automatic data fetching and state management Features: - Automatic column generation from data structure - Integrated with useAnalyticsQuery for data fetching - Built-in loading, error, and empty states - Dynamic filtering, sorting and pagination - Column visibility controls - Responsive design |
| [Dialog](functions/Dialog.md) | - |
| [DialogClose](functions/DialogClose.md) | - |
| [DialogContent](functions/DialogContent.md) | - |
| [DialogDescription](functions/DialogDescription.md) | - |
| [DialogFooter](functions/DialogFooter.md) | - |
| [DialogHeader](functions/DialogHeader.md) | - |
| [DialogOverlay](functions/DialogOverlay.md) | - |
| [DialogPortal](functions/DialogPortal.md) | - |
| [DialogTitle](functions/DialogTitle.md) | - |
| [DialogTrigger](functions/DialogTrigger.md) | - |
| [Drawer](functions/Drawer.md) | - |
| [DrawerClose](functions/DrawerClose.md) | - |
| [DrawerContent](functions/DrawerContent.md) | - |
| [DrawerDescription](functions/DrawerDescription.md) | - |
| [DrawerFooter](functions/DrawerFooter.md) | - |
| [DrawerHeader](functions/DrawerHeader.md) | - |
| [DrawerOverlay](functions/DrawerOverlay.md) | - |
| [DrawerPortal](functions/DrawerPortal.md) | - |
| [DrawerTitle](functions/DrawerTitle.md) | - |
| [DrawerTrigger](functions/DrawerTrigger.md) | - |
| [DropdownMenu](functions/DropdownMenu.md) | - |
| [DropdownMenuCheckboxItem](functions/DropdownMenuCheckboxItem.md) | - |
| [DropdownMenuContent](functions/DropdownMenuContent.md) | - |
| [DropdownMenuGroup](functions/DropdownMenuGroup.md) | - |
| [DropdownMenuItem](functions/DropdownMenuItem.md) | - |
| [DropdownMenuLabel](functions/DropdownMenuLabel.md) | - |
| [DropdownMenuPortal](functions/DropdownMenuPortal.md) | - |
| [DropdownMenuRadioGroup](functions/DropdownMenuRadioGroup.md) | - |
| [DropdownMenuRadioItem](functions/DropdownMenuRadioItem.md) | - |
| [DropdownMenuSeparator](functions/DropdownMenuSeparator.md) | - |
| [DropdownMenuShortcut](functions/DropdownMenuShortcut.md) | - |
| [DropdownMenuSub](functions/DropdownMenuSub.md) | - |
| [DropdownMenuSubContent](functions/DropdownMenuSubContent.md) | - |
| [DropdownMenuSubTrigger](functions/DropdownMenuSubTrigger.md) | - |
| [DropdownMenuTrigger](functions/DropdownMenuTrigger.md) | - |
| [Empty](functions/Empty.md) | - |
| [EmptyContent](functions/EmptyContent.md) | - |
| [EmptyDescription](functions/EmptyDescription.md) | - |
| [EmptyHeader](functions/EmptyHeader.md) | - |
| [EmptyMedia](functions/EmptyMedia.md) | - |
| [EmptyTitle](functions/EmptyTitle.md) | - |
| [Field](functions/Field.md) | - |
| [FieldContent](functions/FieldContent.md) | - |
| [FieldDescription](functions/FieldDescription.md) | - |
| [FieldError](functions/FieldError.md) | - |
| [FieldGroup](functions/FieldGroup.md) | - |
| [FieldLabel](functions/FieldLabel.md) | - |
| [FieldLegend](functions/FieldLegend.md) | - |
| [FieldSeparator](functions/FieldSeparator.md) | - |
| [FieldSet](functions/FieldSet.md) | - |
| [FieldTitle](functions/FieldTitle.md) | - |
| [formatLabel](functions/formatLabel.md) | Formats a field name into a human-readable label. Handles camelCase, snake_case, acronyms, and ALL_CAPS. E.g., "totalSpend" -> "Total Spend", "user_name" -> "User Name", "userID" -> "User Id", "TOTAL_SPEND" -> "Total Spend" |
| [FormControl](functions/FormControl.md) | - |
| [FormDescription](functions/FormDescription.md) | - |
| [FormField](functions/FormField.md) | - |
| [FormItem](functions/FormItem.md) | - |
| [FormLabel](functions/FormLabel.md) | - |
| [FormMessage](functions/FormMessage.md) | - |
| [HoverCard](functions/HoverCard.md) | - |
| [HoverCardContent](functions/HoverCardContent.md) | - |
| [HoverCardTrigger](functions/HoverCardTrigger.md) | - |
| [Input](functions/Input.md) | - |
| [InputGroup](functions/InputGroup.md) | - |
| [InputGroupAddon](functions/InputGroupAddon.md) | - |
| [InputGroupButton](functions/InputGroupButton.md) | - |
| [InputGroupInput](functions/InputGroupInput.md) | - |
| [InputGroupText](functions/InputGroupText.md) | - |
| [InputGroupTextarea](functions/InputGroupTextarea.md) | - |
| [InputOTP](functions/InputOTP.md) | - |
| [InputOTPGroup](functions/InputOTPGroup.md) | - |
| [InputOTPSeparator](functions/InputOTPSeparator.md) | - |
| [InputOTPSlot](functions/InputOTPSlot.md) | - |
| [isArrowTable](functions/isArrowTable.md) | Type guard to check if data is an Arrow Table |
| [isDataProps](functions/isDataProps.md) | Type guard to check if props are data-based |
| [isQueryProps](functions/isQueryProps.md) | Type guard to check if props are query-based |
| [Item](functions/Item.md) | - |
| [ItemActions](functions/ItemActions.md) | - |
| [ItemContent](functions/ItemContent.md) | - |
| [ItemDescription](functions/ItemDescription.md) | - |
| [ItemFooter](functions/ItemFooter.md) | - |
| [ItemGroup](functions/ItemGroup.md) | - |
| [ItemHeader](functions/ItemHeader.md) | - |
| [ItemMedia](functions/ItemMedia.md) | - |
| [ItemSeparator](functions/ItemSeparator.md) | - |
| [ItemTitle](functions/ItemTitle.md) | - |
| [Kbd](functions/Kbd.md) | - |
| [KbdGroup](functions/KbdGroup.md) | - |
| [Label](functions/Label.md) | - |
| [Menubar](functions/Menubar.md) | - |
| [MenubarCheckboxItem](functions/MenubarCheckboxItem.md) | - |
| [MenubarContent](functions/MenubarContent.md) | - |
| [MenubarGroup](functions/MenubarGroup.md) | - |
| [MenubarItem](functions/MenubarItem.md) | - |
| [MenubarLabel](functions/MenubarLabel.md) | - |
| [MenubarMenu](functions/MenubarMenu.md) | - |
| [MenubarPortal](functions/MenubarPortal.md) | - |
| [MenubarRadioGroup](functions/MenubarRadioGroup.md) | - |
| [MenubarRadioItem](functions/MenubarRadioItem.md) | - |
| [MenubarSeparator](functions/MenubarSeparator.md) | - |
| [MenubarShortcut](functions/MenubarShortcut.md) | - |
| [MenubarSub](functions/MenubarSub.md) | - |
| [MenubarSubContent](functions/MenubarSubContent.md) | - |
| [MenubarSubTrigger](functions/MenubarSubTrigger.md) | - |
| [MenubarTrigger](functions/MenubarTrigger.md) | - |
| [NavigationMenu](functions/NavigationMenu.md) | - |
| [NavigationMenuContent](functions/NavigationMenuContent.md) | - |
| [NavigationMenuIndicator](functions/NavigationMenuIndicator.md) | - |
| [NavigationMenuItem](functions/NavigationMenuItem.md) | - |
| [NavigationMenuLink](functions/NavigationMenuLink.md) | - |
| [NavigationMenuList](functions/NavigationMenuList.md) | - |
| [NavigationMenuTrigger](functions/NavigationMenuTrigger.md) | - |
| [NavigationMenuViewport](functions/NavigationMenuViewport.md) | - |
| [normalizeChartData](functions/normalizeChartData.md) | Normalizes chart data from either Arrow or JSON format. Converts BigInt and Date values to chart-compatible types. |
| [normalizeHeatmapData](functions/normalizeHeatmapData.md) | Normalizes data specifically for heatmap charts. Expects data in format: `{ xKey: string, yAxisKey: string, valueKey: number }` |
| [Pagination](functions/Pagination.md) | - |
| [PaginationContent](functions/PaginationContent.md) | - |
| [PaginationEllipsis](functions/PaginationEllipsis.md) | - |
| [PaginationItem](functions/PaginationItem.md) | - |
| [PaginationLink](functions/PaginationLink.md) | - |
| [PaginationNext](functions/PaginationNext.md) | - |
| [PaginationPrevious](functions/PaginationPrevious.md) | - |
| [Popover](functions/Popover.md) | - |
| [PopoverAnchor](functions/PopoverAnchor.md) | - |
| [PopoverContent](functions/PopoverContent.md) | - |
| [PopoverTrigger](functions/PopoverTrigger.md) | - |
| [Progress](functions/Progress.md) | - |
| [RadioGroup](functions/RadioGroup.md) | - |
| [RadioGroupItem](functions/RadioGroupItem.md) | - |
| [ResizableHandle](functions/ResizableHandle.md) | - |
| [ResizablePanel](functions/ResizablePanel.md) | - |
| [ResizablePanelGroup](functions/ResizablePanelGroup.md) | - |
| [ScrollArea](functions/ScrollArea.md) | - |
| [ScrollBar](functions/ScrollBar.md) | - |
| [Select](functions/Select.md) | - |
| [SelectContent](functions/SelectContent.md) | - |
| [SelectGroup](functions/SelectGroup.md) | - |
| [SelectItem](functions/SelectItem.md) | - |
| [SelectLabel](functions/SelectLabel.md) | - |
| [SelectScrollDownButton](functions/SelectScrollDownButton.md) | - |
| [SelectScrollUpButton](functions/SelectScrollUpButton.md) | - |
| [SelectSeparator](functions/SelectSeparator.md) | - |
| [SelectTrigger](functions/SelectTrigger.md) | - |
| [SelectValue](functions/SelectValue.md) | - |
| [Separator](functions/Separator.md) | - |
| [Sheet](functions/Sheet.md) | - |
| [SheetClose](functions/SheetClose.md) | - |
| [SheetContent](functions/SheetContent.md) | - |
| [SheetDescription](functions/SheetDescription.md) | - |
| [SheetFooter](functions/SheetFooter.md) | - |
| [SheetHeader](functions/SheetHeader.md) | - |
| [SheetTitle](functions/SheetTitle.md) | - |
| [SheetTrigger](functions/SheetTrigger.md) | - |
| [Sidebar](functions/Sidebar.md) | - |
| [SidebarContent](functions/SidebarContent.md) | - |
| [SidebarFooter](functions/SidebarFooter.md) | - |
| [SidebarGroup](functions/SidebarGroup.md) | - |
| [SidebarGroupAction](functions/SidebarGroupAction.md) | - |
| [SidebarGroupContent](functions/SidebarGroupContent.md) | - |
| [SidebarGroupLabel](functions/SidebarGroupLabel.md) | - |
| [SidebarHeader](functions/SidebarHeader.md) | - |
| [SidebarInput](functions/SidebarInput.md) | - |
| [SidebarInset](functions/SidebarInset.md) | - |
| [SidebarMenu](functions/SidebarMenu.md) | - |
| [SidebarMenuAction](functions/SidebarMenuAction.md) | - |
| [SidebarMenuBadge](functions/SidebarMenuBadge.md) | - |
| [SidebarMenuButton](functions/SidebarMenuButton.md) | - |
| [SidebarMenuItem](functions/SidebarMenuItem.md) | - |
| [SidebarMenuSkeleton](functions/SidebarMenuSkeleton.md) | - |
| [SidebarMenuSub](functions/SidebarMenuSub.md) | - |
| [SidebarMenuSubButton](functions/SidebarMenuSubButton.md) | - |
| [SidebarMenuSubItem](functions/SidebarMenuSubItem.md) | - |
| [SidebarProvider](functions/SidebarProvider.md) | - |
| [SidebarRail](functions/SidebarRail.md) | - |
| [SidebarSeparator](functions/SidebarSeparator.md) | - |
| [SidebarTrigger](functions/SidebarTrigger.md) | - |
| [Skeleton](functions/Skeleton.md) | - |
| [Slider](functions/Slider.md) | - |
| [sortTimeSeriesAscending](functions/sortTimeSeriesAscending.md) | Sorts time-series data in ascending chronological order. |
| [Spinner](functions/Spinner.md) | - |
| [Switch](functions/Switch.md) | - |
| [Table](functions/Table.md) | - |
| [TableBody](functions/TableBody.md) | - |
| [TableCaption](functions/TableCaption.md) | - |
| [TableCell](functions/TableCell.md) | - |
| [TableFooter](functions/TableFooter.md) | - |
| [TableHead](functions/TableHead.md) | - |
| [TableHeader](functions/TableHeader.md) | - |
| [TableRow](functions/TableRow.md) | - |
| [Tabs](functions/Tabs.md) | - |
| [TabsContent](functions/TabsContent.md) | - |
| [TabsList](functions/TabsList.md) | - |
| [TabsTrigger](functions/TabsTrigger.md) | - |
| [Textarea](functions/Textarea.md) | - |
| [Toaster](functions/Toaster.md) | - |
| [toChartArray](functions/toChartArray.md) | Converts an array of values to chart-compatible types. |
| [toChartValue](functions/toChartValue.md) | Converts a value to a chart-compatible type. Handles BigInt conversion (Arrow can return BigInt64Array values). Handles Date objects by converting to timestamps. |
| [Toggle](functions/Toggle.md) | - |
| [ToggleGroup](functions/ToggleGroup.md) | - |
| [ToggleGroupItem](functions/ToggleGroupItem.md) | - |
| [Tooltip](functions/Tooltip.md) | - |
| [TooltipContent](functions/TooltipContent.md) | - |
| [TooltipProvider](functions/TooltipProvider.md) | - |
| [TooltipTrigger](functions/TooltipTrigger.md) | - |
| [truncateLabel](functions/truncateLabel.md) | Truncates a label to a maximum length with ellipsis. |
| [useAllThemeColors](functions/useAllThemeColors.md) | Hook to get all three color palettes at once. Useful when a component needs access to multiple palette types. |
| [useAnalyticsQuery](functions/useAnalyticsQuery.md) | Subscribe to an analytics query over SSE and returns its latest result. Integration hook between client and analytics plugin. |
| [useChartData](functions/useChartData.md) | Hook for fetching chart data in either JSON or Arrow format. Automatically selects the best format based on query hints. |
| [useFormField](functions/useFormField.md) | - |
| [useSidebar](functions/useSidebar.md) | - |
| [useThemeColors](functions/useThemeColors.md) | Hook to get theme colors with automatic updates on theme change. Re-resolves CSS variables when color scheme or theme attributes change. |
