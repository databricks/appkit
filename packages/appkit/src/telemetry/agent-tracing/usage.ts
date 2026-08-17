import type { AgentUsage } from "shared";

export class AgentUsageAccumulator {
  private modelSteps = 0;
  private value: AgentUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costAvailable: true,
  };

  add(next: AgentUsage): void {
    this.modelSteps += 1;
    this.value.inputTokens += next.inputTokens;
    this.value.outputTokens += next.outputTokens;
    this.value.totalTokens += next.totalTokens;
    this.value.cacheReadInputTokens = addOptional(
      this.value.cacheReadInputTokens,
      next.cacheReadInputTokens,
    );
    this.value.cacheCreationInputTokens = addOptional(
      this.value.cacheCreationInputTokens,
      next.cacheCreationInputTokens,
    );
    this.value.costAvailable &&= next.costAvailable;
    if (next.costUsd !== undefined) {
      this.value.costUsd = (this.value.costUsd ?? 0) + next.costUsd;
    }
  }

  snapshot(): AgentUsage {
    const costAvailable = this.modelSteps > 0 && this.value.costAvailable;
    const { costUsd, ...usage } = this.value;
    return {
      ...usage,
      ...(costAvailable && costUsd !== undefined ? { costUsd } : {}),
      costAvailable,
    };
  }
}

function addOptional(left?: number, right?: number): number | undefined {
  return left === undefined && right === undefined
    ? undefined
    : (left ?? 0) + (right ?? 0);
}
