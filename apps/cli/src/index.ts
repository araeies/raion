#!/usr/bin/env node
import { ServerConfigError } from '@raion/server';
import { EXIT, UsageError, type Output } from './commands.js';
import { createProgram } from './program.js';
import { isCancellation } from './prompt.js';

const io: Output = {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
};

const program = createProgram(io);

try {
  await program.parseAsync();
} catch (error) {
  if (isCancellation(error)) {
    // Ctrl+C at a question: stop quietly. Commands only change things after their last question.
    io.err('\nCancelled.');
    process.exitCode = 130;
  } else if (error instanceof UsageError || error instanceof ServerConfigError) {
    io.err(`error: ${error.message}`);
    process.exitCode = EXIT.USAGE;
  } else {
    io.err(`unexpected error: ${(error as Error).stack ?? String(error)}`);
    process.exitCode = 70;
  }
}
