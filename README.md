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
5. Deploy the script as a web app:
   - Execute as: Me
   - Who has access: Anyone
6. In Netlify, add these environment variables with the `Functions` scope:
   - `APPS_SCRIPT_SYNC_URL`: the Apps Script `/exec` web app URL
   - `APPS_SCRIPT_SYNC_TOKEN`: the same value as `KWTM_SYNC_TOKEN`

Optional Apps Script properties:

- `KWTM_PRIVATE_SHEET_ID`: defaults to the bound private sheet
- `KWTM_STAFF_TODOS_SHEET_ID`: defaults to the staff scheduler sheet ID already in the app
- `KWTM_PUBLIC_STAFF_SHEET_ID`: when set, autosync also updates the `Staff Schedule` tab in that public workbook
