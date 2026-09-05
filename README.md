# Karl Weekly Task Manager

React/Vite app for weekly operations planning: task grid, daily agenda, staff scheduler, bills, carryover, and Google Sheets autosync.

The app reads from two workbook sources:

- Private task workbook: `Tasks`, `Events`, `Categories`, and `Bills`
- Staff scheduling workbook: `Todos`, `DailyNotes`, and `Staff`

## Run Locally

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Netlify

Connect this repository in Netlify and use:

- Build command: `npm run build`
- Publish directory: `dist`

### Private site access

This app uses a Netlify Edge Function for HTTP Basic Auth. In Netlify, add these environment variables with the `Functions` scope before deploying:

- `APP_BASIC_AUTH_USER`
- `APP_BASIC_AUTH_PASSWORD`

Do not add the password to this repository. If either variable is missing, the deployed site returns `503 Site access is not configured.`

Optional:

- `APP_SESSION_SECRET`: signing key for the session cookie. The cookie stores an HMAC of the username and an expiry, never the password. When this variable is absent the key is derived from `APP_BASIC_AUTH_PASSWORD` instead, so the site works without it. Setting it is preferable because changing it revokes every existing session without having to change the password.

Sessions last 30 days. Changing the password or `APP_SESSION_SECRET` invalidates existing cookies, so everyone signs in once more.

### Google Sheets autosync

The app autosyncs through a Netlify Function that calls an Apps Script web app attached to the private Karl task sheet. There is no in-browser Google OAuth client ID.

Apps Script versioning rule: every `apps-script/Code.gs` revision must start with visible top-of-file version lines, before the header comment:

```js
// KWTM_SCRIPT_VERSION: YYYY-MM-DD.N
// KWTM_SCRIPT_UPDATED_AT: YYYY-MM-DD
```

1. Open the private Karl task sheet.
2. Go to Extensions > Apps Script.
3. Paste the contents of `apps-script/Code.gs`.
4. In Apps Script project settings, add this script property:
   - `KWTM_SYNC_TOKEN`
5. Add the daily backup trigger, once per project, from the Apps Script editor's Triggers
   panel (the clock icon): Add Trigger > function `KWTM_dailyBackup`, event source
   Time-driven, Day timer, 3am-4am. Backups of the `Tasks`, `Events`, `Categories` and
   `Bills` tabs run from that trigger rather than on the save path, so the first save of the
   day is not held up copying four tabs. Without the trigger no backups are taken at all.

   Do not add an installer function that calls the trigger service from `Code.gs`. Referencing
   that service anywhere in the file widens the project's OAuth scopes, and a deployed web
   app whose scope set has changed fails every anonymous request until it is re-authorized
   and redeployed. That failure happens before `doPost` runs, so it cannot be caught and
   returned as JSON -- the caller only sees an HTML error page.
6. Deploy the script as a web app:
   - Execute as: Me
   - Who has access: Anyone
7. In Netlify, add these environment variables with the `Functions` scope:
   - `APPS_SCRIPT_SYNC_URL`: the Apps Script `/exec` web app URL
   - `APPS_SCRIPT_SYNC_TOKEN`: the same value as `KWTM_SYNC_TOKEN`

### Archive (permanent record of finished work)

Create an empty Google Sheet, copy its id from the URL, and set it as the
`KWTM_ARCHIVE_SHEET_ID` script property. `KWTM_dailyBackup` then keeps a permanent,
append-only record in that workbook: `Tasks`, `Events` and `Bills` tabs, each row carrying
the original columns plus an `archivedAt` stamp.

One row per task, holding its final state:

- a task that leaves the working sheet stays readable in the archive forever
- an edit replaces the archived row rather than adding to it, so editing never grows the file
- a stale copy never overwrites a newer archived one

Open the **Archive** tab in the app to read it. It is fetched only when that tab is opened,
so a long history never slows down loading the app.

This replaces daily snapshots rather than supplementing them. With an archive configured the
live workbook gets no backup tabs at all, and any left by an earlier version are swept on the
next run. That is what keeps the workbook the app reads on every sync small.

Because history is preserved elsewhere, it is now safe to prune old completed tasks out of
the live `Tasks` tab if it ever grows enough to matter.

### Snapshots (fallback, only when no archive is configured)

`KWTM_dailyBackup` snapshots the `Tasks`, `Events`, `Categories` and `Bills` tabs once a day
and keeps three days. Snapshots default to hidden tabs inside the live workbook, which is
convenient but not free: on 2026-09-02 that workbook held 34 backup tabs totalling 837,902
characters against 271,256 characters of real data, and every sync paid for reading a file
that was 76% snapshots.

Set `KWTM_BACKUP_SHEET_ID` to the id of a separate, empty spreadsheet to move them out. The
live workbook then stays small and every sync gets faster.

Note that Google Sheets keeps its own full version history (File > Version history), which
is a better restore path than these tabs. They exist as a quick in-sheet undo for a bad
write, not as the only safety net -- so keep the retention short.

### Function timeout

Every sync has to finish inside the lifetime of a Netlify function: 10 seconds by default,
26 seconds once Netlify support raises the limit for the site (a Pro-plan option). Apps
Script routinely needs 5-9 seconds for one spreadsheet operation, so the default leaves very
little headroom, and running out of it is what produced every "Apps Script did not answer"
and "returned 200 with a non-JSON body" failure.

The wait is set by the `APPS_SCRIPT_FETCH_TIMEOUT_MS` Netlify environment variable, so it can
be changed without touching code. Unset, it is 9,300ms -- just under the 10s default. Once
Netlify raises this site to 26s, set it to `24000` and redeploy. It is clamped to 25,000ms so
a typo cannot push it past what Netlify allows.

Optional Apps Script properties:

- `KWTM_PRIVATE_SHEET_ID`: defaults to the bound private sheet
- `KWTM_STAFF_TODOS_SHEET_ID`: defaults to the staff scheduler sheet ID already in the app
- `KWTM_PUBLIC_STAFF_SHEET_ID`: when set, autosync also updates the `Staff Schedule` tab in that public workbook
- `KWTM_ARCHIVE_SHEET_ID`: recommended. Permanent append-only record; replaces snapshots entirely
- `KWTM_BACKUP_SHEET_ID`: only used when no archive is configured; moves snapshot tabs out of the live workbook
