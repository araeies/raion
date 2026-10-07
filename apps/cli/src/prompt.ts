import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

export interface Choice<T extends string> {
  value: T;
  label: string;
}

/** Asks a multiple-choice question. Returns the default on empty input. */
export async function choose<T extends string>(
  question: string,
  choices: Choice<T>[],
  defaultValue: T,
): Promise<T> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write(`\n${question}\n`);
    choices.forEach((c, i) =>
      stdout.write(`  ${i + 1}) ${c.label}${c.value === defaultValue ? ' (default)' : ''}\n`),
    );
    for (;;) {
      const answer = (await rl.question('> ')).trim();
      if (answer === '') return defaultValue;
      const index = Number(answer) - 1;
      const byIndex = choices[index];
      if (Number.isInteger(index) && byIndex) return byIndex.value;
      const byValue = choices.find((c) => c.value === answer);
      if (byValue) return byValue.value;
      stdout.write(`Please enter a number between 1 and ${choices.length}.\n`);
    }
  } finally {
    rl.close();
  }
}

export async function ask(
  question: string,
  defaultValue: string,
  validate: (v: string) => string | undefined,
): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    for (;;) {
      const answer =
        (await rl.question(`\n${question} [${defaultValue}]\n> `)).trim() || defaultValue;
      const problem = validate(answer);
      if (!problem) return answer;
      stdout.write(`${problem}\n`);
    }
  } finally {
    rl.close();
  }
}

/** Reads a password without echoing it. Requires an interactive terminal. */
export function askHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY) {
      reject(
        new Error('a terminal is required to enter a password; use --password-stdin in scripts'),
      );
      return;
    }
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    let value = '';
    const onData = (data: Buffer) => {
      for (const char of data.toString('utf8')) {
        if (char === '\r' || char === '\n') {
          cleanup();
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          cleanup();
          stdout.write('\n');
          reject(new Error('cancelled'));
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}

/** Yes/no question; anything but "y"/"yes" means no. */
export async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}
