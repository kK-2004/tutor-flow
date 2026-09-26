import { describe, expect, it } from 'vitest';

import { followedWorkflowStep } from '../../apps/console/src/app/workflow-follow.js';

const order = [
  'QUERY_PLANNING',
  'SEARCH',
  'FETCH_SOURCES',
  'DEDUPE_SOURCES',
  'SCORE_SOURCES',
];

describe('工作流小步骤跟踪', () => {
  it('当前步骤记录滞后时跟踪最新已开始的小步骤', () => {
    expect(
      followedWorkflowStep(
        {
          status: 'RESEARCHING',
          currentStepType: 'SEARCH',
          steps: [
            {
              stepType: 'SEARCH',
              status: 'SUCCEEDED',
              attemptNo: 1,
              startedAt: '2026-09-26T02:00:00.000Z',
            },
            {
              stepType: 'FETCH_SOURCES',
              status: 'RUNNING',
              attemptNo: 1,
              startedAt: '2026-09-26T02:00:01.000Z',
            },
          ],
        },
        order,
      ),
    ).toBe('FETCH_SOURCES');
  });

  it('下一步已排队但尚未开始时跟踪检查点，并处理同毫秒的记录', () => {
    const steps = [
      {
        stepType: 'FETCH_SOURCES',
        status: 'SUCCEEDED',
        attemptNo: 1,
        startedAt: '2026-09-26T02:00:00.000Z',
      },
      {
        stepType: 'DEDUPE_SOURCES',
        status: 'SUCCEEDED',
        attemptNo: 1,
        startedAt: '2026-09-26T02:00:00.000Z',
      },
    ];
    expect(
      followedWorkflowStep(
        { status: 'RESEARCHING', currentStepType: 'SEARCH', steps },
        order,
      ),
    ).toBe('DEDUPE_SOURCES');
    expect(
      followedWorkflowStep(
        {
          status: 'RESEARCHING',
          currentStepType: 'SCORE_SOURCES',
          steps,
        },
        order,
      ),
    ).toBe('SCORE_SOURCES');
  });

  it('终态停在最后实际执行的步骤', () => {
    expect(
      followedWorkflowStep(
        {
          status: 'FAILED',
          currentStepType: 'SEARCH',
          steps: [
            {
              stepType: 'DEDUPE_SOURCES',
              status: 'FAILED',
              attemptNo: 1,
              startedAt: '2026-09-26T02:00:01.000Z',
            },
          ],
        },
        order,
      ),
    ).toBe('DEDUPE_SOURCES');
  });
});
