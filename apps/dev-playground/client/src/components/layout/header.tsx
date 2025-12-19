import { InfoIcon } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@databricks/appkit-ui/react";

export function Header({
  title,
  description,
  tooltip,
}: {
  title: string;
  description: string;
  tooltip: string;
}) {
  return (
    <div className="mb-8">
      <div className="flex items-center gap-3 mb-2">
        <h1 className="text-3xl font-bold text-foreground">{title}</h1>
        <Tooltip>
          <TooltipTrigger>
            <InfoIcon className="w-5 h-5" />
          </TooltipTrigger>
          <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
      </div>
      <p className="text-foreground text-muted-foreground">{description}</p>
    </div>
  );
}
