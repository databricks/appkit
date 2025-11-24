import { InfoIcon } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

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
        <h1 className="text-3xl font-bold">{title}</h1>
        <Tooltip>
          <TooltipTrigger>
            <InfoIcon className="w-5 h-5" />
          </TooltipTrigger>
          <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
      </div>
      <p className="text-base text-gray-500">{description}</p>
    </div>
  );
}
