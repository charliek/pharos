import { listenOnPort } from './mock-service';

/**
 * Bring up two mock user-service instances — `legacy` on :3001 and `new` on
 * :3002 — so the example scenarios can be run end to end:
 *
 *   bun run examples/serve.ts &
 *   LEGACY_BASE_URL=http://127.0.0.1:3001 NEW_BASE_URL=http://127.0.0.1:3002 \
 *     bun run ftest -- run
 */
listenOnPort(3001);
listenOnPort(3002);
