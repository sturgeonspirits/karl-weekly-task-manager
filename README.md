# Karl Weekly Task Manager

React/Vite app for weekly operations planning: task grid, daily agenda, staff scheduler, bills, carryover, and Google Sheets synchronization.

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

The app stores task data locally in the browser until Google Sheets OAuth is configured in the Sheets panel.
