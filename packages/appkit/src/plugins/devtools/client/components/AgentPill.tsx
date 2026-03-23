import React, { useEffect, useRef } from "react";
import type { PillState } from "../types";

interface Props {
  pillState: PillState | null;
  onHide: () => void;
  onClick: () => void;
}

export function AgentPill({ pillState, onHide, onClick }: Props) {
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);

    if (
      pillState &&
      (pillState.status === "done" || pillState.status === "error")
    ) {
      timerRef.current = setTimeout(onHide, 6000);
    }

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [pillState, onHide]);

  if (!pillState) return null;

  const className = [
    "agent-pill",
    "visible",
    pillState.status === "done" ? "done" : "",
    pillState.status === "error" ? "error" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={className} onClick={onClick}>
      <span className="agent-pill-dot" />
      <span className="agent-pill-label">{pillState.label}</span>
      <span className="agent-pill-text">{pillState.text}</span>
    </div>
  );
}
