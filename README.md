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

The app stores task data locally in the browser until Google Sheets OAuth is configured in the Sheets panel.
