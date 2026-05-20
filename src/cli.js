#!/usr/bin/env node

const { loadConfig, ConfigError } = require('./config');
const { ExcelInputError, readPolicyRequests } = require('./excel-reader');
const { JsonLogger } = require('./logger');
const { writeReport, resultOk } = require('./report');
const { WorkdaySecurityAutomator } = require('./rpa');
const {
  initializeRunState,
  recordResult,
  remainingRequestsForResume,
  saveRunState
} = require('./run-state');

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }

  if (!args.excel) {
    console.error('Input error: --excel is required.');
    printHelp();
    return 2;
  }

  try {
    const allRequests = (await readPolicyRequests(args.excel, args.sheet)).map((request, requestIndex) => ({
      ...request,
      requestIndex
    }));
    const config = loadConfig(args.config, args.baseUrl);
    if (args.timeoutMs !== undefined) config.timeoutMs = Number(args.timeoutMs);
    const logFile = args.logFile || `${args.artifactsDir}/run.jsonl`;
    const stateFile = args.stateFile || `${args.artifactsDir}/run-state.json`;
    const logger = new JsonLogger(logFile);
    const state = initializeRunState(stateFile, allRequests, { resume: args.resume });
    const requests = args.resume ? remainingRequestsForResume(allRequests, state) : allRequests;
    saveRunState(stateFile, state);
    logger.info('plan_created', {
      total_requests: allRequests.length,
      pending_requests: requests.length,
      resume: args.resume,
      state_file: stateFile,
      log_file: logFile
    });

    if (args.dryRun) {
      const results = requests.map((request) => ({
        request,
        status: 'dry_run_ok',
        message: 'Excel row parsed successfully.',
        attempts: 1
      }));
      const reportPath = await writeReport(args.out, results);
      console.log(`Dry run OK. Parsed ${requests.length} request(s). Report: ${reportPath}`);
      return 0;
    }

    const automator = new WorkdaySecurityAutomator(config, {
      headless: !args.headed,
      slowMo: args.slowMo,
      artifactsDir: args.artifactsDir,
      maxAttempts: args.maxAttempts,
      actionDelayMs: args.actionDelayMs,
      settleMs: args.settleMs,
      retryDelayMs: args.retryDelayMs,
      viewConfirmationMs: args.viewConfirmationMs,
      userDataDir: args.userDataDir,
      cdpEndpoint: args.cdpEndpoint,
      useExistingPage: args.useExistingPage,
      existingPageUrl: args.existingPageUrl,
      keepOpen: args.keepOpen,
      resetReplicaState: args.resetReplicaState,
      safeMode: args.safeMode,
      screenshotDiff: args.screenshotDiff,
      logger
    });
    const results = await automator.run(requests, {
      onResult: async (result, request) => {
        recordResult(state, request, result, request.requestIndex);
        saveRunState(stateFile, state);
      }
    });
    const reportPath = await writeReport(args.out, results);
    const failed = results.filter((result) => !resultOk(result));

    console.log(`Processed ${results.length} request(s). Report: ${reportPath}`);
    if (failed.length > 0) {
      console.error(`${failed.length} request(s) failed. Check report and artifacts directory: ${args.artifactsDir}`);
      return 1;
    }
    return 0;
  } catch (error) {
    if (error instanceof ExcelInputError || error instanceof ConfigError) {
      console.error(`Input error: ${error.message}`);
      return 2;
    }
    console.error(error.stack || error.message);
    return 1;
  }
}

function parseArgs(argv) {
  const args = {
    config: 'configs/selectors.local.json',
    out: 'reports/run-report.xlsx',
    artifactsDir: 'artifacts',
    maxAttempts: undefined,
    slowMo: undefined,
    actionDelayMs: undefined,
    settleMs: undefined,
    retryDelayMs: undefined,
    viewConfirmationMs: undefined,
    userDataDir: undefined,
    cdpEndpoint: undefined,
    useExistingPage: false,
    existingPageUrl: undefined,
    stateFile: undefined,
    logFile: undefined,
    keepOpen: false,
    resetReplicaState: false,
    resume: false,
    safeMode: false,
    screenshotDiff: undefined,
    timeoutMs: undefined,
    dryRun: false,
    headed: false,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--excel') args.excel = next();
    else if (arg === '--config') args.config = next();
    else if (arg === '--sheet') args.sheet = next();
    else if (arg === '--base-url') args.baseUrl = next();
    else if (arg === '--out') args.out = next();
    else if (arg === '--artifacts-dir') args.artifactsDir = next();
    else if (arg === '--max-attempts') args.maxAttempts = next();
    else if (arg === '--slow-mo') args.slowMo = next();
    else if (arg === '--action-delay') args.actionDelayMs = next();
    else if (arg === '--settle-ms') args.settleMs = next();
    else if (arg === '--retry-delay') args.retryDelayMs = next();
    else if (arg === '--view-confirmation-ms') args.viewConfirmationMs = next();
    else if (arg === '--user-data-dir') args.userDataDir = next();
    else if (arg === '--cdp-endpoint') args.cdpEndpoint = next();
    else if (arg === '--use-existing-page') args.useExistingPage = true;
    else if (arg === '--existing-page-url') args.existingPageUrl = next();
    else if (arg === '--state-file') args.stateFile = next();
    else if (arg === '--log-file') args.logFile = next();
    else if (arg === '--keep-open') args.keepOpen = true;
    else if (arg === '--reset-replica-state') args.resetReplicaState = true;
    else if (arg === '--resume') args.resume = true;
    else if (arg === '--safe-mode') args.safeMode = true;
    else if (arg === '--no-screenshot-diff') args.screenshotDiff = false;
    else if (arg === '--timeout-ms') args.timeoutMs = next();
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--headed') args.headed = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node src/cli.js --excel <request.xlsx> --config <selectors.json> [options]

Options:
  --dry-run                    Validate Excel/config and write report without browser actions
  --headed                     Show the browser while running
  --sheet <name>               Worksheet name. Defaults to the first worksheet
  --base-url <url>             Override config base_url
  --out <path>                 Report path. Default: reports/run-report.xlsx
  --artifacts-dir <path>       Screenshots and trace directory. Default: artifacts
  --max-attempts <number>      Retries per Excel row. Config default: 5
  --slow-mo <ms>               Playwright slow motion in milliseconds
  --action-delay <ms>          Pause before each click/fill for slow enterprise UIs
  --settle-ms <ms>             Pause after each click/fill for UI rendering
  --retry-delay <ms>           Base delay between row retries
  --view-confirmation-ms <ms>  Pause on View Security Group page after validation
  --user-data-dir <path>       Persistent browser profile for replica localStorage
  --cdp-endpoint <url>         Attach to an already-running Chrome/Edge remote debugging endpoint
  --use-existing-page          Use an already-open tab from the attached browser instead of opening a new tab
  --existing-page-url <match>  Prefer an existing tab URL containing this text, wildcard, or /regex/
  --state-file <path>          Resume state path. Default: artifacts/run-state.json
  --log-file <path>            JSONL log path. Default: artifacts/run.jsonl
  --keep-open                  Keep browser open after run for manual inspection
  --reset-replica-state        Clear localhost replica localStorage before running
  --resume                     Continue from saved state and skip completed requests
  --safe-mode                  Extra in-page verification after save without reopening the group
  --no-screenshot-diff         Disable before/after grid screenshot fingerprint check
  --timeout-ms <ms>            Override selector/navigation timeout
`);
}

if (require.main === module) {
  main().then((code) => process.exit(code));
}

module.exports = {
  main,
  parseArgs
};
