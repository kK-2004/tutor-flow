type FollowableStep = {
  stepType: string;
  status: string;
  attemptNo: number;
  startedAt?: string | null;
};

type FollowableRun = {
  status: string;
  currentStepType?: string | null;
  steps: FollowableStep[];
};

export function followedWorkflowStep(
  detail: FollowableRun,
  stepOrder: readonly string[],
): string {
  const latestAttempt = [...detail.steps].sort((a, b) => {
    const timeDiff =
      new Date(b.startedAt ?? 0).getTime() - new Date(a.startedAt ?? 0).getTime();
    if (timeDiff !== 0) return timeDiff;
    const orderDiff = stepOrder.indexOf(b.stepType) - stepOrder.indexOf(a.stepType);
    return orderDiff || b.attemptNo - a.attemptNo;
  })[0];
  const attemptedStep = latestAttempt?.stepType;
  const currentStep = detail.currentStepType;
  if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(detail.status)) {
    return attemptedStep ?? currentStep ?? stepOrder[0] ?? 'QUERY_PLANNING';
  }
  if (
    attemptedStep !== undefined &&
    (currentStep == null ||
      stepOrder.indexOf(attemptedStep) > stepOrder.indexOf(currentStep))
  ) {
    return attemptedStep;
  }
  return currentStep ?? attemptedStep ?? stepOrder[0] ?? 'QUERY_PLANNING';
}
