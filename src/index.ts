/**
 * Public barrel (spec Section 19.1). This is the **only** module a target
 * repo's `hooks/index.ts` and tooling may import from — `import { ... } from
 * 'pharos'` once the git dependency is installed, or the relative path from
 * inside this repo. Everything re-exported here is an API commitment: adding
 * an export is fine, removing or reshaping one is a breaking change for every
 * consumer pinned to a commit SHA. Keep this surface deliberately small.
 *
 * Internal modules (`src/execution/*`, `src/comparison/*`, `src/cli/*`, etc.)
 * are implementation detail and stay unexported — they may change shape
 * freely between commits.
 */

// --- Config (spec Section 6): the shape of pharos.config.json/.yaml once loaded. ---
export {
  type ConfigOverride,
  defaultConfig,
  type LoadConfigOptions,
  loadConfig,
  type PharosConfig,
  type RedactionTargets,
} from './config/config';
// --- Contract schema and types (spec Section 5): for tooling that generates ---
// --- or programmatically inspects behavioral contracts.                    ---
export {
  type Contract,
  type ContractRoute,
  contractRouteSchema,
  contractSchema,
  type HttpMethod,
  httpMethodSchema,
} from './contract/model';
// --- Hooks (spec Section 7.2): the shape a hooks/index.ts module authors against. ---
export {
  type HookContext,
  HookError,
  type HookFn,
  type HookOutput,
  type NormalizerFn,
} from './execution/hooks';
// --- Scenario schema and types (spec Section 4): for tooling that generates ---
// --- or programmatically inspects scenario files.                          ---
export {
  COMPARE_STRATEGIES,
  type CompareStrategy,
  type ExtractRule,
  type HookRef,
  modeSchema,
  REQUEST_METHODS,
  type RequestMethod,
  SCENARIO_MODES,
  type Scenario,
  type ScenarioCompare,
  type ScenarioMode,
  type ScenarioRequest,
  type ScenarioSafety,
  type ScenarioStep,
  scenarioSchema,
  strategySchema,
} from './scenarios/schema';
