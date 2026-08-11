#!/usr/bin/env bun
/**
 * License + dependency audit (spec Section 3.6).
 *
 * Walks node_modules for every installed package's package.json --
 * including scoped @org/pkg packages and nested node_modules from version
 * conflicts -- and checks each `license` field against an allowlist of
 * permissive licenses. A missing/empty or non-allowlisted license fails.
 * Dependency-free by design: it must never trust the tree it's auditing.
 */
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';

const ALLOWLIST = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'CC0-1.0',
  '0BSD',
  'Zlib',
  'Unlicense',
  'BlueOak-1.0.0',
  'Python-2.0',
  'CC-BY-4.0',
]);

interface PackageInfo {
  name: string;
  version: string;
  license: string;
}

/** "(A OR B)" passes if any alternative is allowlisted; "(A AND B)" requires all. */
function isAllowlisted(expression: string): boolean {
  const trimmed = expression.trim();
  const unwrapped =
    trimmed.startsWith('(') && trimmed.endsWith(')') ? trimmed.slice(1, -1) : trimmed;
  if (unwrapped.includes(' AND ')) return unwrapped.split(' AND ').every(isAllowlisted);
  if (unwrapped.includes(' OR ')) return unwrapped.split(' OR ').some(isAllowlisted);
  return ALLOWLIST.has(unwrapped);
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null; // broken symlink or missing path
  }
}

function readdirOrEmpty(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (err) {
    // Only a genuinely missing directory is empty evidence; any other error
    // (permissions, I/O) is missing evidence, and an audit that cannot read
    // its input must fail rather than report a smaller, cleaner world.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    console.error(`audit: cannot read ${dir}: ${String(err)}`);
    process.exit(1);
  }
}

/** Recursively collects one PackageInfo per package.json under `dir`,
 * descending into scoped @org/pkg dirs and nested node_modules from
 * version conflicts. `visited` is keyed by realpath and shared across the
 * whole walk, so a symlink cycle is resolved once and never re-descended. */
function walk(dir: string, visited: Set<string>, out: Map<string, PackageInfo>): void {
  const real = realpathOrNull(dir);
  if (!real || visited.has(real)) return;
  visited.add(real);

  for (const entry of readdirOrEmpty(real)) {
    if (entry.startsWith('.')) continue; // .bin, .package-lock.json, ...
    const entryPath = join(real, entry);
    if (entry.startsWith('@')) {
      for (const pkg of readdirOrEmpty(entryPath))
        collectPackage(join(entryPath, pkg), visited, out);
    } else {
      collectPackage(entryPath, visited, out);
    }
  }
}

function collectPackage(dir: string, visited: Set<string>, out: Map<string, PackageInfo>): void {
  const real = realpathOrNull(dir);
  if (!real) return;
  const pkgJsonPath = join(real, 'package.json');
  if (!out.has(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
      out.set(pkgJsonPath, {
        name: pkg.name ?? basename(real),
        version: pkg.version ?? 'unknown',
        license: typeof pkg.license === 'string' ? pkg.license.trim() : '',
      });
    } catch (err) {
      // A missing package.json just means this directory is not a package --
      // still walk any nested node_modules it contains. An existing manifest
      // we cannot read or parse is missing evidence, and fails the audit.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`audit: cannot read ${pkgJsonPath}: ${String(err)}`);
        process.exit(1);
      }
    }
  }
  walk(join(real, 'node_modules'), visited, out);
}

function main(): void {
  const packages = new Map<string, PackageInfo>();
  walk(join(process.cwd(), 'node_modules'), new Set(), packages);

  const licenseCounts = new Map<string, number>();
  const failures: string[] = [];
  for (const pkg of packages.values()) {
    const label = pkg.license === '' ? '(missing)' : pkg.license;
    licenseCounts.set(label, (licenseCounts.get(label) ?? 0) + 1);
    if (pkg.license === '' || !isAllowlisted(pkg.license)) {
      failures.push(`${pkg.name}@${pkg.version} (${label})`);
    }
  }

  console.log('License summary:');
  for (const [license, count] of [...licenseCounts.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    console.log(`  ${license}: ${count}`);
  }
  console.log(`\nTotal packages audited: ${packages.size}`);

  if (failures.length > 0) {
    console.log(`\nFailed allowlist (${failures.length}):`);
    for (const failure of failures.sort((a, b) => a.localeCompare(b))) console.log(`  ${failure}`);
    process.exit(1);
  }

  console.log('\nAll packages pass the license allowlist.');
}

main();
