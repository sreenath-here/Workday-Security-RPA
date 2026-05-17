const fs = require('node:fs');
const path = require('node:path');
const { chromium, errors } = require('playwright');
const { JsonLogger } = require('./logger');
const { captureLocatorFingerprint } = require('./screenshot-diff');

class RpaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RpaError';
  }
}

class SelectorMissingError extends RpaError {
  constructor(message) {
    super(message);
    this.name = 'SelectorMissingError';
  }
}

async function retry(operation, { attempts, delayMs = 1000, retryable = [RpaError, errors.TimeoutError] }) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return { value: await operation(), attempts: attempt };
    } catch (error) {
      lastError = error;
      const shouldRetry = retryable.some((errorType) => error instanceof errorType);
      if (!shouldRetry || attempt === attempts) break;
      await sleep(delayMs * attempt);
    }
  }
  throw lastError || new RpaError('Operation failed without an exception.');
}

class WorkdaySecurityAutomator {
  constructor(config, options = {}) {
    this.config = config;
    this.headless = options.headless ?? true;
    const automation = config.automation || {};
    this.slowMo = numberOption(options.slowMo, automation.slow_mo_ms, 0);
    this.artifactsDir = options.artifactsDir || 'artifacts';
    this.maxAttempts = numberOption(options.maxAttempts, automation.max_attempts, 5);
    this.actionDelayMs = numberOption(options.actionDelayMs, automation.action_delay_ms, 0);
    this.settleMs = numberOption(options.settleMs, automation.settle_ms, 0);
    this.retryDelayMs = numberOption(options.retryDelayMs, automation.retry_delay_ms, 2500);
    this.viewConfirmationMs = numberOption(options.viewConfirmationMs, automation.view_confirmation_ms, 0);
    this.userDataDir = options.userDataDir || automation.user_data_dir || '';
    this.keepOpen = options.keepOpen ?? false;
    this.resetReplicaState = options.resetReplicaState ?? false;
    this.safeMode = options.safeMode ?? Boolean(automation.safe_mode);
    this.screenshotDiffEnabled = options.screenshotDiff ?? automation.screenshot_diff_enabled !== false;
    this.logger = options.logger || new JsonLogger();
    this.policyCache = new Map();
    this.browser = undefined;
  }

  async run(requests, runOptions = {}) {
    fs.mkdirSync(this.artifactsDir, { recursive: true });
    this.logger.info('run_start', { request_count: requests.length, safe_mode: this.safeMode });
    const context = await this.newBrowserContext();
    context.setDefaultTimeout(this.config.timeoutMs);
    context.setDefaultNavigationTimeout(this.config.timeoutMs);
    const tracePath = path.join(this.artifactsDir, 'trace.zip');
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const page = await context.newPage();

    try {
      await page.goto(this.config.baseUrl, { waitUntil: 'domcontentloaded', timeout: this.config.timeoutMs });
      await this.resetReplicaStorageIfRequested(page);
      await this.waitForUiToSettle(page);
      await this.loginIfNeeded(page);

      const results = [];
      for (const [index, request] of requests.entries()) {
        this.logger.info('row_start', this.logRequest(request));
        const result = await this.processWithRetry(page, request);
        results.push(result);
        this.logger.info('row_finish', { ...this.logRequest(request), status: result.status, message: result.message });
        await runOptions.onResult?.(result, request, index);
      }
      this.logger.info('run_finish', { request_count: requests.length });
      return results;
    } finally {
      if (this.keepOpen) {
        await stopTrace(context, tracePath);
        console.log('Browser kept open for inspection. Close the browser window or press Ctrl+C when finished.');
        await waitUntilContextCloses(context);
      } else {
        await stopTrace(context, tracePath);
        await context.close();
        await this.browser?.close().catch(() => {});
      }
    }
  }

  async newBrowserContext() {
    const launchOptions = {
      headless: this.headless,
      slowMo: this.slowMo,
      args: browserArgsFor(this.config.baseUrl)
    };

    if (this.userDataDir) {
      fs.mkdirSync(this.userDataDir, { recursive: true });
      return chromium.launchPersistentContext(this.userDataDir, launchOptions);
    }

    const browser = await chromium.launch(launchOptions);
    this.browser = browser;
    return browser.newContext();
  }

  async loginIfNeeded(page) {
    const login = this.config.login;
    if (!login.enabled) return;

    this.logger.info('login_start');
    await this.fill(page, login, 'username_input', login.username, { required: true });
    await this.fill(page, login, 'password_input', login.password, { required: true });
    await this.click(page, login, 'submit_button', { required: true });
    await this.waitFor(page, login, 'post_login_ready', { required: true });
    this.logger.info('login_finish');
  }

  async resetReplicaStorageIfRequested(page) {
    const storageKey = this.config.workflow.replica_storage_key;
    if (!this.resetReplicaState || !storageKey) return;
    await page.evaluate((key) => localStorage.removeItem(key), storageKey);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: this.config.timeoutMs });
  }

  async processWithRetry(page, request) {
    try {
      const { value, attempts } = await retry(() => this.processRequest(page, request), {
        attempts: this.maxAttempts,
        delayMs: this.retryDelayMs
      });
      return { ...value, attempts };
    } catch (error) {
      const screenshotPath = await this.screenshot(page, request);
      return {
        request,
        status: 'failed',
        message: error.message,
        attempts: this.maxAttempts,
        screenshotPath
      };
    }
  }

  async processRequest(page, request) {
    const values = this.values(request);
    const workflow = this.config.workflow;

    await this.openTask(page, workflow, values);
    await this.fill(page, workflow, 'security_group_input', request.securityGroup, { required: true, values });
    await this.click(page, workflow, 'security_group_result', { required: true, values });
    await this.click(page, workflow, 'ok_button', { required: true, values });
    await this.hydratePolicyCache(page, workflow, request.securityGroup);

    if (request.action === 'verify') {
      const found = await this.policyAccessPresent(page, workflow, request, this.config.timeoutMs);
      if (!found) {
        throw new RpaError(`Verification failed: ${request.access} / ${request.domainPolicy} is not assigned.`);
      }
      await this.verifyReplicaStorageIfConfigured(page, request);
      await this.confirmOnViewPageThenReturnHome(page, workflow, values);
      return { request, status: 'verified', message: `${request.access} / ${request.domainPolicy} exists and passed verification.` };
    }

    if (await this.policyAccessPresent(page, workflow, request, this.presenceCheckMs())) {
      await this.verifyReplicaStorageIfConfigured(page, request);
      await this.confirmOnViewPageThenReturnHome(page, workflow, values);
      return { request, status: 'already_present', message: `${request.access} is already assigned and persisted for this policy.` };
    }

    const beforeFingerprint = await this.captureGridFingerprint(page, workflow, request, 'before-save');
    await this.click(page, workflow, 'add_policy_button', { required: true, values });
    await this.click(page, workflow, 'access_field', { required: true, values });
    await this.fill(page, workflow, 'access_lookup_input', request.access, { required: true, values });
    await this.click(page, workflow, 'access_result', { required: true, values });
    await this.fill(page, workflow, 'domain_policy_input', request.domainPolicy, { required: true, values });
    await this.click(page, workflow, 'domain_policy_result', { required: true, values });
    await this.click(page, workflow, 'save_button', { required: true, values });
    await this.waitForUiToSettle(page);
    const afterFingerprint = await this.captureGridFingerprint(page, workflow, request, 'after-save');

    if (await this.isVisible(page, workflow, 'success_message', { values, timeoutMs: this.config.timeoutMs })) {
      await this.verifyReplicaStorageIfConfigured(page, request);
      this.assertScreenshotChangedIfNeeded(request, beforeFingerprint, afterFingerprint);
      await this.verifySafeModeIfNeeded(page, workflow, request);
      this.addPolicyCacheEntry(request.securityGroup, request);
      await this.confirmOnViewPageThenReturnHome(page, workflow, values);
      return { request, status: 'added', message: 'Policy added and success message detected.' };
    }
    if (await this.policyAccessPresent(page, workflow, request, this.config.timeoutMs)) {
      await this.verifyReplicaStorageIfConfigured(page, request);
      this.assertScreenshotChangedIfNeeded(request, beforeFingerprint, afterFingerprint);
      await this.verifySafeModeIfNeeded(page, workflow, request);
      this.addPolicyCacheEntry(request.securityGroup, request);
      await this.confirmOnViewPageThenReturnHome(page, workflow, values);
      return { request, status: 'added', message: `${request.access} added, validated in policy list, and persisted in replica storage.` };
    }

    throw new RpaError('Save completed, but the requested policy/access validation was not detected.');
  }

  async openTask(page, workflow, values) {
    await this.ensureSearchAvailable(page, workflow, values);
    if (!workflow.global_search_input) return;
    await this.fill(page, workflow, 'global_search_input', workflow.task_name || '', { required: true, values });
    await this.click(page, workflow, 'global_search_result', { required: true, values });
  }

  async ensureSearchAvailable(page, workflow, values) {
    if (!workflow.global_search_input) return;
    if (await this.isVisible(page, workflow, 'global_search_input', { values, timeoutMs: 1000 })) return;
    await this.returnHomeIfPossible(page, workflow, values);
  }

  async returnHomeIfPossible(page, workflow, values) {
    await this.click(page, workflow, 'return_home_button', { required: false, values, timeoutMs: 3000 });
  }

  async confirmOnViewPageThenReturnHome(page, workflow, values) {
    await this.waitForViewConfirmation(page, workflow);
    await this.returnHomeIfPossible(page, workflow, values);
  }

  async fill(page, selectors, key, value, options) {
    const locator = await this.locator(page, selectors, key, options);
    if (!locator) return;
    this.logger.info('fill', { selector_key: key, value: redactValue(key, value) });
    await this.beforeAction(locator);
    await locator.fill('');
    await this.pause(this.actionDelayMs);
    await locator.fill(value, { timeout: this.config.timeoutMs });
    await this.afterAction(page);
  }

  async click(page, selectors, key, options) {
    const locator = await this.locator(page, selectors, key, options);
    if (!locator) return;
    this.logger.info('click', { selector_key: key });
    await this.beforeAction(locator);
    await locator.click({ timeout: this.config.timeoutMs });
    await this.afterAction(page);
  }

  async waitFor(page, selectors, key, options) {
    const locator = await this.locator(page, selectors, key, options);
    if (locator) await locator.waitFor({ state: 'visible', timeout: this.config.timeoutMs });
  }

  async locator(page, selectors, key, options = {}) {
    const required = options.required ?? false;
    const values = options.values || {};
    const timeoutMs = options.timeoutMs ?? (required ? this.config.timeoutMs : 2000);
    const candidates = asList(selectors[key]);

    if (candidates.length === 0) {
      if (required) throw new SelectorMissingError(`Required selector '${key}' is missing from config.`);
      return undefined;
    }

    const errorsSeen = [];
    for (const candidate of candidates) {
      const selector = formatSelector(candidate, values);
      try {
        const locator = candidateLocator(page, selector).first();
        await locator.waitFor({ state: 'visible', timeout: timeoutMs });
        await locator.waitFor({ state: 'attached', timeout: timeoutMs });
        this.logger.info('selector_match', { selector_key: key, selector });
        return locator;
      } catch (error) {
        errorsSeen.push(`${selector}: ${error.message}`);
      }
    }

    if (required) {
      throw new SelectorMissingError(`Could not find required selector '${key}'. Tried: ${errorsSeen.join(' | ')}`);
    }
    return undefined;
  }

  async isVisible(page, selectors, key, options) {
    try {
      return Boolean(await this.locator(page, selectors, key, { ...options, required: false }));
    } catch {
      return false;
    }
  }

  async policyAccessPresent(page, workflow, request, timeoutMs) {
    if (this.hasPolicyCacheEntry(request.securityGroup, request)) return true;

    const values = this.values(request);
    const configuredRow = await this.locator(page, workflow, 'existing_policy_row', {
      required: false,
      values,
      timeoutMs
    });
    if (configuredRow) return true;

    const gridSelector = workflow.permissions_grid || '[data-testid="domain-permissions-grid"], [data-testid="view-security-group-grid"]';
    try {
      await page.locator(gridSelector).first().waitFor({ state: 'visible', timeout: timeoutMs });
      const matchingRows = page
        .locator(gridSelector)
        .locator('tbody tr')
        .filter({ hasText: request.domainPolicy })
        .filter({ hasText: request.access });
      const found = (await matchingRows.count()) > 0;
      if (found) this.addPolicyCacheEntry(request.securityGroup, request);
      return found;
    } catch {
      return false;
    }
  }

  async waitForViewConfirmation(page, workflow) {
    const gridSelector = workflow.permissions_grid || '[data-testid="domain-permissions-grid"], [data-testid="view-security-group-grid"]';
    await page.locator(gridSelector).first().waitFor({ state: 'visible', timeout: this.config.timeoutMs }).catch(() => {});
    await this.pause(this.viewConfirmationMs);
  }

  async verifyReplicaStorageIfConfigured(page, request) {
    const storageKey = this.config.workflow.replica_storage_key;
    if (!storageKey) return;

    const found = await page.evaluate(
      ({ key, policy, access }) => {
        const saved = localStorage.getItem(key);
        if (!saved) return false;
        try {
          const parsed = JSON.parse(saved);
          return Array.isArray(parsed.rows) && parsed.rows.some((row) => row.policy === policy && row.access === access);
        } catch {
          return false;
        }
      },
      { key: storageKey, policy: request.domainPolicy, access: request.access }
    );

    if (!found) {
      throw new RpaError(`${request.access} / ${request.domainPolicy} was visible on screen but was not persisted in replica storage.`);
    }
  }

  async verifySafeModeIfNeeded(page, workflow, request) {
    if (!this.safeMode) return;
    const values = this.values(request);
    this.logger.info('safe_mode_verify_start', this.logRequest(request));
    await this.confirmOnViewPageThenReturnHome(page, workflow, values);
    await this.openTask(page, workflow, values);
    await this.fill(page, workflow, 'security_group_input', request.securityGroup, { required: true, values });
    await this.click(page, workflow, 'security_group_result', { required: true, values });
    await this.click(page, workflow, 'ok_button', { required: true, values });
    this.policyCache.delete(request.securityGroup);
    const verified = await this.policyAccessPresent(page, workflow, request, this.config.timeoutMs);
    if (!verified) {
      throw new RpaError(`Safe mode re-open verification failed for ${request.access} / ${request.domainPolicy}.`);
    }
    this.logger.info('safe_mode_verify_finish', this.logRequest(request));
  }

  async hydratePolicyCache(page, workflow, securityGroup) {
    if (this.policyCache.has(securityGroup)) return;
    const rows = await this.readGridRows(page, workflow, this.presenceCheckMs());
    this.policyCache.set(securityGroup, rows);
    this.logger.info('policy_cache_hydrated', { security_group: securityGroup, policies: rows.length });
  }

  async readGridRows(page, workflow, timeoutMs) {
    const gridSelector = workflow.permissions_grid || '[data-testid="domain-permissions-grid"], [data-testid="view-security-group-grid"]';
    try {
      await page.locator(gridSelector).first().waitFor({ state: 'visible', timeout: timeoutMs });
      return page
        .locator(gridSelector)
        .locator('tbody tr')
        .evaluateAll((rows) => rows.map((row) => {
          const cells = [...row.querySelectorAll('td')].map((cell) => cell.textContent.replace(/\s+/g, ' ').trim());
          if (cells.length >= 4) return { access: cells[2], policy: cells[3] };
          return { access: cells[0] || '', policy: cells[1] || '' };
        }).filter((row) => row.access && row.policy));
    } catch {
      return [];
    }
  }

  hasPolicyCacheEntry(securityGroup, request) {
    return (this.policyCache.get(securityGroup) || []).some((row) => {
      return row.access.includes(request.access) && row.policy.includes(request.domainPolicy);
    });
  }

  addPolicyCacheEntry(securityGroup, request) {
    const rows = this.policyCache.get(securityGroup) || [];
    if (!this.hasPolicyCacheEntry(securityGroup, request)) {
      rows.push({ access: request.access, policy: request.domainPolicy });
      this.policyCache.set(securityGroup, rows);
    }
  }

  async captureGridFingerprint(page, workflow, request, stage) {
    if (!this.screenshotDiffEnabled) return undefined;
    const gridSelector = workflow.permissions_grid || '[data-testid="domain-permissions-grid"], [data-testid="view-security-group-grid"]';
    const fileName = `row-${request.rowNumber}-${safeFilePart(request.access)}-${stage}.png`;
    const filePath = path.join(this.artifactsDir, 'diffs', fileName);
    try {
      const locator = page.locator(gridSelector).first();
      await locator.waitFor({ state: 'visible', timeout: this.presenceCheckMs() });
      return captureLocatorFingerprint(locator, filePath);
    } catch {
      return undefined;
    }
  }

  assertScreenshotChangedIfNeeded(request, beforeFingerprint, afterFingerprint) {
    if (!this.screenshotDiffEnabled || !beforeFingerprint || !afterFingerprint) return;
    if (beforeFingerprint === afterFingerprint) {
      throw new RpaError(`Grid screenshot did not change after saving ${request.access} / ${request.domainPolicy}.`);
    }
  }

  async screenshot(page, request) {
    const screenshotPath = path.join(this.artifactsDir, `row-${request.rowNumber}-failure.png`);
    try {
      await page.screenshot({ path: screenshotPath, fullPage: true });
      return screenshotPath;
    } catch {
      return undefined;
    }
  }

  async beforeAction(locator) {
    await locator.scrollIntoViewIfNeeded({ timeout: this.config.timeoutMs }).catch(() => {});
    await expectEnabled(locator, this.config.timeoutMs);
    await this.pause(this.actionDelayMs);
  }

  async afterAction(page) {
    await this.waitForUiToSettle(page);
    await this.pause(this.settleMs);
  }

  async waitForUiToSettle(page) {
    await page.waitForLoadState('domcontentloaded', { timeout: this.config.timeoutMs }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: Math.min(this.config.timeoutMs, 5000) }).catch(() => {});
    await this.handleInterruptions(page);
    await this.waitForSpinnersToDisappear(page);
  }

  async pause(ms) {
    if (ms > 0) await sleep(ms);
  }

  presenceCheckMs() {
    return Number((this.config.automation || {}).presence_check_ms || 5000);
  }

  values(request) {
    return {
      security_group: request.securityGroup,
      domain_policy: request.domainPolicy,
      access: request.access || '',
      task_name: this.config.workflow.task_name || ''
    };
  }

  logRequest(request) {
    return {
      row_number: request.rowNumber,
      security_group: request.securityGroup,
      domain_policy: request.domainPolicy,
      access: request.access,
      request_index: request.requestIndex
    };
  }

  async handleInterruptions(page) {
    const workflow = this.config.workflow || {};
    const buttons = asList(workflow.interruption_buttons);
    for (const selector of buttons) {
      try {
        const locator = candidateLocator(page, selector).first();
        if (await locator.isVisible({ timeout: 500 })) {
          this.logger.warn('interruption_dismiss', { selector });
          await locator.click({ timeout: 1000 }).catch(() => {});
        }
      } catch {
        // Ignore optional global popup handlers.
      }
    }
  }

  async waitForSpinnersToDisappear(page) {
    const workflow = this.config.workflow || {};
    const spinners = asList(workflow.spinner_selectors);
    for (const selector of spinners) {
      try {
        const locator = candidateLocator(page, selector).first();
        await locator.waitFor({ state: 'hidden', timeout: Math.min(this.config.timeoutMs, 10000) });
      } catch {
        // Spinner selectors are best-effort because apps use many transient overlays.
      }
    }
  }
}

function asList(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function formatSelector(selector, values) {
  return Object.entries(values).reduce(
    (formatted, [key, value]) => formatted.replaceAll(`{${key}}`, value),
    selector
  );
}

function candidateLocator(page, selector) {
  if (selector.startsWith('css=')) return page.locator(selector.slice(4));
  if (selector.startsWith('xpath=')) return page.locator(selector.slice(6));
  if (selector.startsWith('text=')) return page.getByText(selector.slice(5), { exact: true });
  if (selector.startsWith('label=')) return page.getByLabel(selector.slice(6), { exact: true });
  if (selector.startsWith('placeholder=')) return page.getByPlaceholder(selector.slice(12), { exact: true });
  if (selector.startsWith('testid=')) return page.getByTestId(selector.slice(7));
  if (selector.startsWith('role=')) return roleLocator(page, selector);
  return page.locator(selector);
}

function browserArgsFor(baseUrl) {
  try {
    const port = new URL(baseUrl).port;
    return port ? [`--explicitly-allowed-ports=${port}`] : [];
  } catch {
    return [];
  }
}

function numberOption(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return Number(value);
  }
  return 0;
}

function safeFilePart(value) {
  return String(value || 'item').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60);
}

function redactValue(key, value) {
  if (/password|secret|token/i.test(key)) return '[redacted]';
  return value;
}

async function expectEnabled(locator, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await locator.isEnabled({ timeout: 500 })) return;
    } catch {
      return;
    }
    await sleep(250);
  }
}

function roleLocator(page, selector) {
  const match = selector.match(/^role=([a-zA-Z0-9_-]+)(\[name=(['"])(.*?)\3\])?$/);
  if (!match) throw new SelectorMissingError(`Invalid role selector: ${selector}`);
  const [, role, , , name] = match;
  return name ? page.getByRole(role, { name, exact: true }) : page.getByRole(role);
}

async function stopTrace(context, tracePath) {
  try {
    await context.tracing.stop({ path: tracePath });
  } catch {
    await context.tracing.stop().catch(() => {});
  }
}

async function waitUntilContextCloses(context) {
  const pages = context.pages();
  if (pages.length === 0) return;
  await Promise.race(pages.map((page) => page.waitForEvent('close').catch(() => {})));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  RpaError,
  SelectorMissingError,
  WorkdaySecurityAutomator,
  asList,
  candidateLocator,
  formatSelector,
  retry,
  browserArgsFor
};
