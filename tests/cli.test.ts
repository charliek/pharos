import { describe, expect, it } from 'vitest';
import { buildProgram } from '../src/cli/program';

describe('cli program', () => {
  it('exposes the four MVP subcommands', () => {
    const program = buildProgram();
    const names = program.commands.map((command) => command.name()).sort();
    expect(names).toEqual(['check-contract', 'record', 'run', 'validate']);
  });

  it('reports its version', () => {
    const program = buildProgram();
    expect(program.version()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
