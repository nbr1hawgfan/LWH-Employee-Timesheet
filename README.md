# LWH Timesheet (employee PWA)

Employees sign in with their employee ID and a 6-digit PIN to see their timeclock punches and
hours for the current Sunday–Saturday week plus the 4 before it. Hours only; no pay data.

## Deploy
1. Create repo `LWH-Employee-Timesheet`, push these files to the root, enable GitHub Pages
   (main branch, root). URL: https://nbr1hawgfan.github.io/LWH-Employee-Timesheet/
2. `config.js` already points at LWH Companion with the publishable key. That key can only call
   the four employee functions; every table is closed to it.
3. If the Pages URL differs, update `AppUrl` in Timesheet-Sync `config.json` (printed on slips).

## Updating
Bump `CACHE` in `sw.js` and `APP_VERSION` in `config.js` on each release. The service worker is
network-first, so phones pick up changes on the next open.

## Behavior notes
- Missing clock-out: open punch older than 16 hours (red banner + hatched red bar).
- On the clock: open punch within 16 hours (covers overnight shifts).
- Location/team only shown when a week has more than one site.
- Sessions last 30 days per device; Sign out ends it immediately.
