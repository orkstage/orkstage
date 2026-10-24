// SPDX-License-Identifier: AGPL-3.0-only
import { DescribeTasksCommand, ECSClient, RunTaskCommand, StopTaskCommand } from '@aws-sdk/client-ecs';
import { pause, RemoteSession, type TofuExecResult, type TofuExecutor } from './executor.js';

const STOP_GRACE_MS = 2 * 60_000;

export interface EcsExecutorOptions {
  /** Defaults to a client with the worker's own AWS credentials (its task role). */
  client?: Pick<ECSClient, 'send'>;
  /** Region of the cluster when `client` is not given; the SDK default otherwise. */
  region?: string;
  cluster: string;
  /**
   * Task definition of the runner (family, family:revision or ARN). Its container runs the runner
   * image with `entryPoint: ["/bin/sh", "-c"]` and mounts the shared work volume (EFS) at
   * `remoteRoot`, as the same user as the worker.
   */
  taskDefinition: string;
  /** Name of the runner container in the task definition. */
  container: string;
  subnets: string[];
  securityGroups: string[];
  assignPublicIp?: boolean;
  launchType?: 'FARGATE' | 'EC2';
  /** Mount point of the shared work volume in the runner task. */
  remoteRoot: string;
  /** How often the task is polled. */
  pollMs?: number;
  /** How long a task may take to stop once asked (cancel, timeout) before it is left to ECS. */
  stopGraceMs?: number;
}

/**
 * One ECS task per OpenTofu session (ADR 0016): init, validate and the commands of one operation
 * run in the same task, so a deployment pays the task start once per resource and step. The
 * worker needs `ecs:RunTask`, `ecs:DescribeTasks`, `ecs:StopTask` and `iam:PassRole` on the
 * task's roles; it never needs the Docker socket.
 */
export function ecsExecutor(opts: EcsExecutorOptions): TofuExecutor {
  const pollMs = opts.pollMs ?? 3000;
  const client = opts.client ?? new ECSClient({ region: opts.region });
  const stopGraceMs = opts.stopGraceMs ?? STOP_GRACE_MS;
  return {
    async run(stack, dir, commands, timeoutMs) {
      const session = new RemoteSession(dir, opts.remoteRoot);
      await session.write(stack, commands);
      try {
        const started = await client.send(
          new RunTaskCommand({
            cluster: opts.cluster,
            taskDefinition: opts.taskDefinition,
            launchType: opts.launchType ?? 'FARGATE',
            count: 1,
            startedBy: 'orkstage',
            networkConfiguration: {
              awsvpcConfiguration: { subnets: opts.subnets, securityGroups: opts.securityGroups, assignPublicIp: opts.assignPublicIp ? 'ENABLED' : 'DISABLED' },
            },
            // The command only: no credentials (RunTask parameters are recorded by CloudTrail).
            overrides: { containerOverrides: [{ name: opts.container, command: [session.command] }] },
          }),
        );
        const taskArn = started.tasks?.[0]?.taskArn;
        if (!taskArn) {
          const failure = started.failures?.[0];
          return session.collect(commands.length, { kind: 'failed', reason: `ECS did not start the task${failure ? `: ${failure.reason ?? ''} ${failure.detail ?? ''}`.trimEnd() : '.'}` });
        }

        let kind: TofuExecResult['kind'] = 'failed';
        let stopRequested = false;
        let stoppedAt = 0;
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          if (!stopRequested && (stack.signal?.aborted || Date.now() > deadline)) {
            kind = stack.signal?.aborted ? 'cancelled' : 'timeout';
            stopRequested = true;
            stoppedAt = Date.now();
            await client.send(new StopTaskCommand({ cluster: opts.cluster, task: taskArn, reason: `OrkStage: ${kind}` })).catch(() => {});
          }
          const described = await client.send(new DescribeTasksCommand({ cluster: opts.cluster, tasks: [taskArn] }));
          const task = described.tasks?.[0];
          if (!task) return session.collect(commands.length, { kind, reason: 'ECS no longer reports the task.' });
          if (task.lastStatus === 'STOPPED') {
            const container = task.containers?.find((c) => c.name === opts.container);
            const reason = [task.stoppedReason, container?.reason].filter(Boolean).join(': ');
            return session.collect(commands.length, { kind, reason: reason || undefined });
          }
          // A task that ignores the stop request is left to ECS rather than waited on forever.
          if (stopRequested && Date.now() > stoppedAt + stopGraceMs) return session.collect(commands.length, { kind, reason: `Task ${taskArn} did not stop in time.` });
          await pause(pollMs, stopRequested ? undefined : stack.signal);
        }
      } finally {
        await session.clean(commands.length);
      }
    },
  };
}
