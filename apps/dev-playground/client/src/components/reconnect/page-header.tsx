import { InfoIcon } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@databricks/app-kit-ui/react";

export function PageHeader() {
  return (
    <div className="mb-8">
      <div className="flex items-center gap-3 mb-2">
        <h1 className="text-3xl font-bold">Stream Reconnection Test</h1>
        <Tooltip>
          <TooltipTrigger>
            <InfoIcon className="w-5 h-5" />
          </TooltipTrigger>
          <TooltipContent>
            Tests SSE (Server-Sent Events) stream reconnection with
            Last-Event-ID tracking
          </TooltipContent>
        </Tooltip>
      </div>
      <p className="text-base text-gray-500">
        Watch automatic stream reconnection in action
      </p>
    </div>
  );
}
