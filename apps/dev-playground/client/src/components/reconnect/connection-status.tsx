import {
  Badge,
  Button,
  Card,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@databricks/app-kit-ui/react";
import { InfoIcon } from "lucide-react";
import { Timeline } from "./timeline";
import { getStatusBadgeStyle } from "./utils";

interface ConnectionStatusProps {
  status: string;
  messageCount: number;
  onRestart: () => void;
}

export function ConnectionStatus({
  status,
  messageCount,
  onRestart,
}: ConnectionStatusProps) {
  return (
    <Card className="mb-6 p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h3 className="text-xl font-semibold text-foreground">
            Connection Status
          </h3>
          <Tooltip>
            <TooltipTrigger>
              <InfoIcon className="w-5 h-5" />
            </TooltipTrigger>
            <TooltipContent>
              Current connection status. Watch for disconnection and automatic
              reconnection behavior
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="flex items-center gap-3">
          <Badge className={`${getStatusBadgeStyle(status)} px-3 py-1 text-sm`}>
            {status}
          </Badge>
          <Button onClick={onRestart}>Restart Test</Button>
        </div>
      </div>

      <Timeline status={status} messageCount={messageCount} />

      <div className="flex items-center justify-center gap-2">
        <h2 className="text-4xl font-bold text-foreground">{messageCount}</h2>
        <p className="text-base text-muted-foreground">/ 5 messages received</p>
      </div>
    </Card>
  );
}
