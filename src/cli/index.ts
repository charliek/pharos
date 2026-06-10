#!/usr/bin/env bun
import { buildProgram } from './program';

buildProgram()
  .parseAsync(process.argv)
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
