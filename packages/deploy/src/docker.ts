import { execFile } from 'node:child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class DockerError extends Error {
  constructor(
    message: string,
    readonly result: ExecResult,
  ) {
    super(message);
  }
}

export interface Runner {
  run(
    args: string[],
    options?: { timeoutMs?: number; cwd?: string; input?: string },
  ): Promise<ExecResult>;
}

/**
 * Runs the docker CLI with an argument array. Never uses a shell, so no value can be
 * interpreted as a command: this is the only place Raion executes a process.
 */
export const dockerRunner: Runner = {
  run(args, options = {}) {
    return new Promise((resolve) => {
      const child = execFile(
        'docker',
        args,
        {
          timeout: options.timeoutMs ?? 120_000,
          maxBuffer: 32 * 1024 * 1024,
          windowsHide: true,
          ...(options.cwd ? { cwd: options.cwd } : {}),
        },
        (error, stdout, stderr) => {
          const code =
            error === null
              ? 0
              : typeof error.code === 'number'
                ? error.code
                : error.killed
                  ? 124
                  : 1;
          resolve({
            stdout,
            stderr: error && code !== 0 && !stderr ? error.message : stderr,
            code,
          });
        },
      );
      if (options.input !== undefined) child.stdin?.end(options.input);
    });
  },
};

export async function mustRun(
  runner: Runner,
  args: string[],
  what: string,
  timeoutMs?: number,
): Promise<ExecResult> {
  const result = await runner.run(args, timeoutMs ? { timeoutMs } : {});
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split('\n').slice(-8).join('\n');
    throw new DockerError(`${what} failed (exit ${result.code}):\n${detail}`, result);
  }
  return result;
}
