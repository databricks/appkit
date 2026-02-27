import {
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuTrigger,
    Sidebar,
    SidebarContent,
    SidebarGroup,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarHeader,
    SidebarInput,
    SidebarInset,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarProvider,
    SidebarRail,
    SidebarTrigger,
    Item,
    ItemActions,
    ItemContent,
    ItemDescription,
    ItemTitle,
    Label,
} from "@databricks/appkit-ui/react"
import { useState } from "react"

export default function SidebarExample() {
    const data = {
        versions: ["1.0.1", "1.1.0-alpha", "2.0.0-beta1"],
        navMain: [
            {
                title: "Getting Started",
                url: "#",
                items: [
                    {
                        title: "Installation",
                        url: "#",
                    },
                    {
                        title: "Project Structure",
                        url: "#",
                    },
                ],
            },
            {
                title: "Build Your Application",
                url: "#",
                items: [
                    {
                        title: "Routing",
                        url: "#",
                    },
                    {
                        title: "Data Fetching",
                        url: "#",
                        isActive: true,
                    },
                    {
                        title: "Rendering",
                        url: "#",
                    },
                    {
                        title: "Caching",
                        url: "#",
                    },
                    {
                        title: "Styling",
                        url: "#",
                    },
                    {
                        title: "Optimizing",
                        url: "#",
                    },
                    {
                        title: "Configuring",
                        url: "#",
                    },
                    {
                        title: "Testing",
                        url: "#",
                    },
                    {
                        title: "Authentication",
                        url: "#",
                    },
                    {
                        title: "Deploying",
                        url: "#",
                    },
                    {
                        title: "Upgrading",
                        url: "#",
                    },
                    {
                        title: "Examples",
                        url: "#",
                    },
                ],
            },
            {
                title: "API Reference",
                url: "#",
                items: [
                    {
                        title: "Components",
                        url: "#",
                    },
                    {
                        title: "File Conventions",
                        url: "#",
                    },
                    {
                        title: "Functions",
                        url: "#",
                    },
                    {
                        title: "next.config.js Options",
                        url: "#",
                    },
                    {
                        title: "CLI",
                        url: "#",
                    },
                    {
                        title: "Edge Runtime",
                        url: "#",
                    },
                ],
            },
            {
                title: "Architecture",
                url: "#",
                items: [
                    {
                        title: "Accessibility",
                        url: "#",
                    },
                    {
                        title: "Fast Refresh",
                        url: "#",
                    },
                    {
                        title: "Next.js Compiler",
                        url: "#",
                    },
                    {
                        title: "Supported Browsers",
                        url: "#",
                    },
                    {
                        title: "Turbopack",
                        url: "#",
                    },
                ],
            },
        ],
    }

    const [selectedVersion, setSelectedVersion] = useState(data.versions[0])

    return (
        <SidebarProvider>
            <Sidebar>
                <SidebarHeader>
                    <SidebarMenu>
                        <SidebarMenuItem>
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <SidebarMenuButton
                                        size="lg"
                                        className="data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground"
                                    >
                                        <Item className="p-0 w-full" size="sm">
                                            <ItemContent>
                                                <ItemTitle className="text-sm">Documentation</ItemTitle>
                                                <ItemDescription>v{selectedVersion}</ItemDescription>
                                            </ItemContent>
                                            <ItemActions className="ml-auto">
                                                <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-4 shrink-0 opacity-50"><path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/></svg>
                                            </ItemActions>
                                        </Item>
                                    </SidebarMenuButton>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent>
                                    <DropdownMenuGroup>
                                        {data.versions.map((version) => (
                                            <DropdownMenuItem
                                                key={version}
                                                onSelect={() => setSelectedVersion(version)}
                                            >
                                                v{version}{" "}
                                                {version === selectedVersion && (
                                                    <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="ml-auto size-4"><path d="M20 6 9 17l-5-5"/></svg>
                                                )}
                                            </DropdownMenuItem>
                                        ))}
                                    </DropdownMenuGroup>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </SidebarMenuItem>
                    </SidebarMenu>
                    <form>
                        <SidebarGroup className="py-0">
                            <SidebarGroupContent className="relative">
                                <Label htmlFor="search" className="sr-only">
                                    Search
                                </Label>
                                <SidebarInput
                                    id="search"
                                    placeholder="Search the docs..."
                                    className="pl-8"
                                />
                                <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 opacity-50 select-none"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                            </SidebarGroupContent>
                        </SidebarGroup>
                    </form>
                </SidebarHeader>
                <SidebarContent>
                    {data.navMain.map((item) => (
                        <SidebarGroup key={item.title}>
                            <SidebarGroupLabel>{item.title}</SidebarGroupLabel>
                            <SidebarGroupContent>
                                <SidebarMenu>
                                    {item.items.map((subItem) => (
                                        <SidebarMenuItem key={subItem.title}>
                                            <SidebarMenuButton asChild isActive={subItem.isActive}>
                                                <a href={subItem.url}>{subItem.title}</a>
                                            </SidebarMenuButton>
                                        </SidebarMenuItem>
                                    ))}
                                </SidebarMenu>
                            </SidebarGroupContent>
                        </SidebarGroup>
                    ))}
                </SidebarContent>
                <SidebarRail />
            </Sidebar>
            <SidebarInset>
                <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
                    <SidebarTrigger className="-ml-1" />
                </header>
                <div className="flex flex-1 flex-col gap-4 p-4">
                    <div className="grid auto-rows-min gap-4 md:grid-cols-3">
                        <div className="bg-muted/50 aspect-video rounded-xl" />
                        <div className="bg-muted/50 aspect-video rounded-xl" />
                        <div className="bg-muted/50 aspect-video rounded-xl" />
                    </div>
                    <div className="bg-muted/50 min-h-[100vh] flex-1 rounded-xl md:min-h-min" />
                </div>
            </SidebarInset>
        </SidebarProvider>
    )
}