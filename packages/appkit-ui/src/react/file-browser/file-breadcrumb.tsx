import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "../ui/breadcrumb";

/** Props for the FileBreadcrumb component */
export interface FileBreadcrumbProps
  extends Omit<React.ComponentProps<"nav">, "children"> {
  /** Label for the root breadcrumb item */
  rootLabel: string;
  /** Path segments after the root */
  segments: string[];
  /** Called when the root breadcrumb is clicked */
  onNavigateToRoot: () => void;
  /** Called when a segment breadcrumb is clicked (receives segment index) */
  onNavigateToSegment: (index: number) => void;
}

/** Path-aware breadcrumb navigation built on top of Breadcrumb primitives */
export function FileBreadcrumb({
  rootLabel,
  segments,
  onNavigateToRoot,
  onNavigateToSegment,
  ...props
}: FileBreadcrumbProps) {
  return (
    <Breadcrumb data-slot="file-breadcrumb" {...props}>
      <BreadcrumbList>
        <BreadcrumbItem>
          {segments.length > 0 ? (
            <BreadcrumbLink
              className="cursor-pointer"
              onClick={onNavigateToRoot}
            >
              {rootLabel}
            </BreadcrumbLink>
          ) : (
            <BreadcrumbPage>{rootLabel}</BreadcrumbPage>
          )}
        </BreadcrumbItem>
        {segments.map((segment, index) => (
          <span key={segment} className="contents">
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              {index === segments.length - 1 ? (
                <BreadcrumbPage>{segment}</BreadcrumbPage>
              ) : (
                <BreadcrumbLink
                  className="cursor-pointer"
                  onClick={() => onNavigateToSegment(index)}
                >
                  {segment}
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>
          </span>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
