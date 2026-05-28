# EFNL Junior Football Dashboard

Live results dashboard for EFNL junior football. Displays ladder, results, top scorers, and Game of the Week across all age groups and grades.

**Live site:** https://[your-username].github.io/efnl-dashboard

---

## Repo structure

```
index.html          ← Single-file dashboard app
data.json           ← All match + player data (exported from admin panel)
assets/
  clubs/
    norwood/
      crest.png     ← Club crest (shown in ladder + results)
      badge.png     ← Club badge (optional)
    south_croydon/
      crest.png
    mitcham/
      crest.png
    ...             ← One folder per club, name lowercased with underscores
  competitions/
    efnl/
      badge.png     ← Competition logo (optional)
```

### Club folder naming
Lowercase, spaces → underscores, common suffixes stripped:
- `Norwood` → `norwood`
- `South Croydon` → `south_croydon`
- `Glen Waverley Rovers` → `glen_waverley_rovers`
- `North Ringwood` → `north_ringwood`
- `Beaconsfield Football Club` → `beaconsfield`

Crest images should be square PNGs with transparent backgrounds, any size (displayed at 18–40px).

---

## Updating results (weekly workflow)

1. In PlayHQ, open each grade's fixture page for the latest round
2. **File → Save Page As → Webpage, Complete** — save the `.html` file
3. Open `index.html` in your browser (or visit the GitHub Pages URL)
4. Click **⚙ Admin** → enter password → **Upload data** → **Results pages**
5. Select all the saved `.html` files and click **Save**
6. Repeat for **Stats pages** if you want updated scorer data (save each page of each grade's Statistics tab)
7. Go to **Admin → Manage → ⬇ data.json** and download the exported file
8. Commit `data.json` to this repo — the live site updates for everyone

---

## Updating stats (scorer data)

PlayHQ stats pages show 50 players per page. For a full grade with 200+ players:
1. Go to the grade's Statistics tab on PlayHQ
2. Save page 1, then click Next and save page 2, etc.
3. Upload all pages at once in Admin → Stats pages
4. Private players are automatically excluded
5. Players who appear in multiple grades have their goals combined into one record

---

## First-time setup

1. Fork or clone this repo
2. Enable GitHub Pages: **Settings → Pages → Source: main branch, / (root)**
3. Open the live URL, click **⚙ Admin**
4. First login shows a **set password** screen — choose your password (hashed with SHA-256, never stored in plain text)
5. Upload your first results files
6. Export `data.json` and commit it

---

## Grade movement rules

Set in **Admin → Team roster**:
- Each team has a current grade assigned
- A match counts for the **ladder and team stats** only if both teams are in the same current grade
- **Individual player goals always count** regardless of grade movement
- Mismatched matches are shown greyed out in the results list

---

## Admin password

Stored as a SHA-256 hash in browser localStorage — never in plain text, never committed to the repo. To reset if forgotten: clear localStorage for the site and go through first-time setup again.

---

## Data persistence

- **Public viewers** load data from `data.json` in the repo (committed after each update)
- **Admin uploads** save to browser localStorage as well, so your session persists between uploads before you export
- `data.json` never contains the password hash

---

## Version history

| Version | Changes |
|---------|---------|
| 1.0 | Initial release — ladder, results, scorers, GOTW, multi-age-group support |
