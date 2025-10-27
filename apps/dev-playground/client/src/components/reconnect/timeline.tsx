import { getTimelineSteps } from "./utils";

interface TimelineProps {
  status: string;
  messageCount: number;
}

export function Timeline({ status, messageCount }: TimelineProps) {
  const timelineSteps = getTimelineSteps(status, messageCount);

  return (
    <div className="mb-8 relative">
      <div className="absolute top-4 left-8 right-8 h-0.5 bg-gray-200 z-0" />
      <div className="flex items-center justify-between relative z-10">
        {timelineSteps.map((step) => (
          <div key={step.label} className="flex-1 flex flex-col items-center">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center border-3 mb-2 transition-all duration-300 ${
                step.completed
                  ? "bg-green-400 border-green-600"
                  : step.active
                    ? "bg-yellow-300 border-yellow-600"
                    : "bg-gray-200 border-gray-400"
              }`}
              style={{ borderWidth: "3px" }}
            >
              {step.completed && (
                <span className="text-white font-bold text-base">✓</span>
              )}
              {step.active && !step.completed && (
                <span className="w-3 h-3 rounded-full bg-white" />
              )}
            </div>
            <p
              className={`text-xs text-center ${step.active ? "font-semibold text-gray-900" : "text-gray-500"}`}
            >
              {step.label}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
