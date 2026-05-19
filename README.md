# Workday Security RPA

Node.js + Playwright RPA for adding domain security policies to a security group from an Excel request list. Initially tested on Workday replica first, with selectors kept in JSON so the tool can survive UI text/id changes without code edits.

## What It Does

- Reads an Excel file with security group and domain security policy rows.
- Opens the configured Workday replica URL.
- Optionally logs in.
- Searches/opens the configured security policy task.
- Groups rows by security group, adds all requested domain policies for that group in one open/save cycle, then moves to the next group.
- Skips policies that already appear to be assigned.
- Retries transient UI failures.
- Captures screenshots/traces for failures.
- Writes an Excel run report with row-level status.

## Setup

```powershell
npm install
npm run install:browsers
```

## Prepare the Request Excel

Required columns:

- `Security Group`
- `Domain Security Policy`
- `View`
- `Modify`
- `Get`
- `Put`

Optional column:

- `Action` supports `add` and `verify`

Permission mapping:

- `View=Y`, `Modify=Y` becomes `View and Modify`
- `View=Y`, `Modify=N` becomes `View Only`
- `Get=Y`, `Put=Y` becomes `Get and Put`
- `Get=Y`, `Put=N` becomes `Get Only`
- `Modify=Y` requires `View=Y`
- `Put=Y` requires `Get=Y`

Create a starter workbook:

```powershell
npm run create-template -- .\samples\request_list.xlsx
```

## Configure the Replica UI

This repo already includes `configs/selectors.local.json` for your replica at `http://localhost:4190/`.

To make another config, copy the sample:

```powershell
Copy-Item .\configs\selectors.sample.json .\configs\selectors.local.json
```

Edit:

- `base_url`
- login selectors if your replica needs login
- workflow selectors to match your replica buttons, fields, and success messages

Selectors support these formats:

- `css=.selector`
- `text=Visible Text`
- `label=Field Label`
- `placeholder=Search`
- `testid=my-test-id`
- `role=button[name="Save"]`

Selectors may include `{security_group}`, `{domain_policy}`, and `{task_name}` placeholders.

## Run

Dry-run Excel validation only:

```powershell
node .\src\cli.js --excel .\samples\request_list.xlsx --config .\configs\selectors.local.json --dry-run
```

Run the browser visibly:

```powershell
node .\src\cli.js --excel .\samples\request_list.xlsx --config .\configs\selectors.local.json --headed
```

Run and keep the bot browser open after completion:

```powershell
node .\src\cli.js --excel .\samples\request_list.xlsx --config .\configs\selectors.local.json --headed --keep-open
```

Clean replica test run:

```powershell
node .\src\cli.js --excel .\samples\request_list.xlsx --config .\configs\selectors.local.json --headed --reset-replica-state --keep-open
```

Run visibly with extra slow observation:

```powershell
node .\src\cli.js --excel .\samples\request_list.xlsx --config .\configs\selectors.local.json --headed --slow-mo 750 --action-delay 1200 --settle-ms 1800 --view-confirmation-ms 10000
```

Run headless and write a report:

```powershell
node .\src\cli.js --excel .\samples\request_list.xlsx --config .\configs\selectors.local.json --out .\reports\run-report.xlsx
```

Resume after interruption:

```powershell
node .\src\cli.js --excel .\samples\request_list.xlsx --config .\configs\selectors.local.json --headed --resume
```

Production-style safe mode:

```powershell
node .\src\cli.js --excel .\samples\request_list.xlsx --config .\configs\selectors.local.json --headed --safe-mode --resume
```

## Reliability Notes

No RPA can honestly guarantee zero errors against a changing browser UI, but this tool is structured for production-style reliability:

- every row is isolated;
- resume state is written after every completed request in `artifacts/run-state.json`;
- structured JSON logs are written to `artifacts/run.jsonl`;
- row failures do not stop the whole run;
- UI actions wait for visible/enabled controls and include configurable human-paced delays;
- DOM stability checks wait for network idle and configured spinner disappearance;
- safe mode performs an extra post-save verification on the View Security Group page without reopening the same group;
- before/after grid screenshots are fingerprinted to catch silent UI changes;
- existing policies are cached per security group during a run to avoid repeated duplicate checks;
- common interruption buttons can be dismissed through configured global handlers;
- rows are retried with slower backoff;
- already-assigned policies are treated as success;
- after validation, the browser pauses on the View Security Group page so you can visually confirm the added policy before the tool returns home for the next row;
- failures include screenshots;
- final output is auditable in Excel.

Replica persistence note:

The localhost replica stores changes in browser `localStorage`, not in a backend database. The tool therefore uses a persistent Playwright profile at `.workday-rpa-profile` and verifies the requested policy/access in that saved replica storage after UI validation. To inspect the added policies after a run, use `--headed --keep-open` and check inside the bot browser window. A separate normal Chrome window has separate localStorage and will not show the bot's replica changes. Use `--reset-replica-state` when you want a clean demo from the replica's default state.

Before pointing it at a real Workday tenant, keep it on the replica until the report matches manual validation.
