## 2026-07-10 Task: todo-1 (Add pino/pino-http/pino-pretty dependencies)

### Versions Pinned
- pino: ^10.0.0 (resolved to 10.3.1)
- pino-http: ^11.0.0 (resolved to 11.0.0)
- pino-pretty: ^13.0.0 (resolved to 13.1.3)

### Key Notes
- npm install completed successfully (exit 0), added 27 packages
- npm run build passes with zero errors (exit 0)
- All packages importable via node_modules
- Commit hash: 7e712ba

### Known Issues / Warnings
- UUID deprecation warning (uuid@9.0.1) - existing transitive dep, not blocking
- 13 vulnerabilities reported by npm audit (not addressed per plan - no `npm audit fix`)
- Allow-scripts warnings for esbuild and protobufjs (existing build deps, not blocking)

### Next Tasks Waiting
- Todo 2: Create src/logger.ts (depends on this completion)
- Todos 3-7: Consumption of logger module
- Todo 8: .env.example docs (independent, Wave 1)
- Todo 9: test/logger.test.ts
- Todo 10: Test cleanup

## 2026-07-10 Task: todo-8 (Create .env.example with logging vars)

### File Created
- `tenetx-mimic-backend/.env.example` with 11 environment variables:
  - 8 existing: FIREBASE_REFRESH_TOKEN, MIMIC_STATUS_SECRET, ALLOWED_ORIGIN, HOST, PORT, MIMIC_IDP_ENTITY_ID, MIMIC_IDP_SSO_URL, MIMIC_IDP_CERT_FILE
  - 3 new logging: LOG_LEVEL, NODE_ENV, LOG_PRETTY

### Key Details
- All variables have blank values (safe for git commit)
- Comment block for MIMIC_IDP_* vars copied verbatim from .env (lines 8-12)
- Comment block for logging vars per task spec
- File is NOT gitignored (exit code 1 from git check-ignore = not ignored) ✓

### Verification Results
- Variable coverage: missingFromExample=[], exampleVarCount=11, hasAllNewLoggingVars=true ✓
- Secret leak check: leaked=[] ✓
- File encoded as UTF-8 without BOM to ensure proper Node.js parsing

### Next Tasks Waiting
- Todo 2: Create src/logger.ts (depends on todo-1, now unblocked)
- Todos 3-7: Consumption of logger module
- Todo 9: test/logger.test.ts
- Todo 10: Test cleanup


## 2026-07-10 Task: todo-2 (Create src/logger.ts)

### What Landed
- Created `tenetx-mimic-backend/src/logger.ts` exporting exactly 7 names: logger, createHttpLogger, resolveLogLevel, REDACT_CONFIG, shouldIgnoreHealthCheck, stripQueryString, serializeRequest.
- tsc --noEmit exit 0; npm run build exit 0; both QA scenarios pass. Evidence: .omo/evidence/task-2-tenetx-mimic-backend-logging.txt
- Commit hash: (see decisions.md / git log)

### pino-http v11 IMPORT gotcha (READ THIS before todo 3-7 import it)
- pino-http v11 .d.ts uses `export default PinoHttp; export { PinoHttp as pinoHttp }` with NO `export =`. Under NodeNext, `import pinoHttp from "pino-http"` binds to the NON-callable module namespace -> TS2349 "This expression is not callable".
- FIX: named import `import { pinoHttp } from "pino-http"`. Callable for tsc AND runtime.
- NOTE: `import pino from "pino"` (default) still works fine as the plan said - different export shape. Only pino-HTTP needs the named import.

### pino-http GENERIC-inference gotcha
- Options<IM>.autoLogging.ignore is (req: IM) => boolean. Passing shouldIgnoreHealthCheck (param {url?:string}) makes TS infer IM={url?:string}, stripping .headers off genReqId req -> TS2339.
- FIX: pin call generics `pinoHttp<IncomingMessage, ServerResponse>({...})` (import type from "http"). Do NOT annotate genReqId params (contravariance fails).

### tsx -e QA harness note
- At repo root, tsx -e transforms as CJS -> top-level await fails. Wrap dynamic import in (async () => { ... })().

### Next Tasks Unblocked
- Todos 3,4,5,6,7,9 can now import { logger, createHttpLogger } from "./logger.js".

## 2026-07-10 Task: todo-6 (Migrate statusToken.ts console.warn to logger)

### What Landed
- `tenetx-mimic-backend/src/statusToken.ts` imports `{ logger }` from `./logger.js` at line 2
- Single `console.warn()` call (lines 19-21) replaced with `logger.warn()` on line 19
- Message text preserved exactly: "MIMIC_STATUS_SECRET not set. Falling back to an insecure dev-only secret; status tokens are forgeable."

### Verification Results
- ✓ No console.* calls remain: `node -e "...filter(l=>/console\./.test(l))"` returned `[]`
- ✓ JSON warn-level log emitted when MIMIC_STATUS_SECRET unset (captured in .omo/evidence/task-6-tenetx-mimic-backend-logging.txt)
- ✓ Secret constant `tenetx-mimic-dev-only-insecure-secret` NOT leaked in output
- ✓ npm run build: exit 0 (no TS errors)
- ✓ npx vitest run test/statusToken.test.ts: all 13 tests pass (4ms)
- Evidence file: .omo/evidence/task-6-tenetx-mimic-backend-logging.txt

### Key Notes
- test/statusToken.test.ts has NO console.warn assertions (pre-verified, safe to migrate)
- Logger integration inherited from todo-2 (logger.warn works correctly with string message)
- No secret values (DEV_ONLY_SECRET or computed SECRET) logged anywhere

### Next Tasks Unblocked
- Todo 10: Test cleanup (now has todo 6 landed, is waiting on todos 5,7,9)
