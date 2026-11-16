# Academic Affairs — Weekly Accomplishment Reporting (v3)

A fast rebuild of the weekly reporting app: a static web page that talks straight to
**Firebase** (Firestore database + Google sign-in). No Apps Script, no Google Sheet.

- **Fast:** the page reads and writes the database directly, keeps a copy on the device,
  and shows your change before the server answers.
- **Live:** other people's changes appear without reloading.
- **Signed in:** people sign in with Google. Members change only their own work; admins
  can edit everyone and manage the roster.

> **Status (2026-11-16):** connected to the Firebase project `aa-weekly-reporting`
> (Firestore in `asia-southeast1`; Google sign-in on; rules
> published). Checked live as an admin from `localhost`: sign-in, loading, adding a task,
> saving a %, change history, submitting a week and permanent delete all worked.
> **Not yet checked:** what a non-admin member can and cannot do (needs a second
> account), and sign-in from the published web address (the address must first be added
> under Authentication → Settings → Authorized domains).

## Try it now (local preview, no account needed)

```bash
npm start
```

Open http://localhost:5173. While `js/config.js` has `firebaseConfig = null`, the app runs
in preview: no sign-in, sample people, and everything stays in that browser.

```bash
npm test
```

## Go live (about 15 minutes, once)

Do this signed in to the Google account that should own the data.

1. **Create the project.** https://console.firebase.google.com → Add project. Analytics is not needed.
2. **Create the database.** Build → Firestore Database → Create database → *Production mode* →
   location `asia-southeast1` (Singapore, closest to Manila).
3. **Set the access rules.** Firestore → Rules → replace everything with the contents of
   [`firestore.rules`](firestore.rules) → Publish.
4. **Turn on Google sign-in.** Build → Authentication → Get started → Sign-in method → Google → Enable.
5. **Register the web app.** Project settings (gear) → Your apps → Web (`</>`) → register →
   copy the `firebaseConfig` object into [`js/config.js`](js/config.js), replacing `null`.
6. **Make yourself the first admin.** Firestore → Data → Start collection `members` →
   Document ID = your Google email in lower case → fields:
   `email` (string, same email), `name` (string), `role` (string), `admin` (boolean `true`), `active` (boolean `true`).
   After this, add everyone else from the app: Team → Add member.
7. **Publish the page.** Push this folder to a GitHub repository and enable Pages
   (Settings → Pages → deploy from branch, root). Then in Firebase → Authentication →
   Settings → Authorized domains, add the Pages address (for example `your-org.github.io`).

The values in `js/config.js` are public identifiers, not passwords. What protects the data
is sign-in plus `firestore.rules`.

## How it is used

1. **My Week** — type a planned task and press Enter. During the week, add additional work
   with the time it took and whether it affected a planned task.
2. Enter one **% done** per planned task. It saves when you leave the field. Leave it blank
   until measured: blank tasks stay out of the average.
3. For an incomplete task, open **Reason if incomplete** and choose why.
4. **Submit the week** — keeps a frozen copy that later edits never change.
5. **Team** shows everyone's week and the roster; **Reports** builds a text report, exports
   CSV, prints, and lists the frozen weeks.

## Files

| Path | What it is |
|---|---|
| `index.html`, `css/styles.css` | Page and styling |
| `js/app.js` | Screens and interactions |
| `js/logic.js` | All rules and calculations (pure, tested) |
| `js/data-firebase.js` | Live data: Firestore + Google sign-in |
| `js/data-local.js` | Local preview data (browser only) |
| `js/config.js` | Firebase settings (`null` = preview) |
| `firestore.rules` | Who may read and write what |
| `tests/logic.test.mjs` | Tests for `js/logic.js` |
| `dev-server.mjs` | Local preview server |

## Data model (Firestore)

- `members/{email}` — `name`, `role`, `admin`, `active`
- `tasks/{id}` — the task with its `notes`, time `logs` and `affected_by` links embedded.
  Derived on every save: `minutes` (sum of logs), `open`, `weeks` (Mondays it is dated in).
- `tasks/{id}/events` — change history
- `snapshots/{week__email}` — frozen weekly record, including the report text
- `deletions/{id}` — copy of a permanently deleted task (admins only)

A week's screen is two live queries: tasks dated in that week, and every task still open.

## Differences from v2 (Apps Script + Sheets)

- Sign-in is required; "anyone with the link can edit" is gone.
- Fields save by themselves; there is no "Save percentages" button and no outcome note
  required at 100%.
- Time on a task is always the sum of its time logs.
- Submitting stores the whole week, so a saved week really is frozen.
- There is no automatic Friday snapshot (that needed a server); each person submits.
- Data is not in a Google Sheet. Use the CSV export for spreadsheets.

## Not built yet

- Importing existing records from the v2 Google Sheet.
- A whole-team frozen snapshot (only per-person submissions exist).
- Automated tests for `firestore.rules` (needs the Firebase emulator, which needs Java).
