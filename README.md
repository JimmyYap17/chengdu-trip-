# Trip Planner

A Home Screen app for a trip: day plans with a leave-by timer, a ticket wallet for QR/barcode screenshots and PDFs, AMap links with a show-the-driver view, and a booking tracker, shared between two phones through Firebase.

**App address:** https://jimmyyap17.github.io/chengdu-trip-/

## Setup

1. **Turn on GitHub Pages:** in this repo go to **Settings → Pages**, choose **Deploy from a branch**, branch `main`, folder `/ (root)`, and save. The app is live at the address above a minute later.
2. **Install:** open the address in Safari, then **Share → Add to Home Screen**. It installs as **Trip**.
3. **Sign in:** pick a username and password for the trip and use the same pair on both phones. Everything you add (tickets, booking refs, ticks, addresses) is stored under that shared account.
4. **Unlock:** the first time, enter the trip passphrase. The account remembers it, so the second phone doesn't ask.

## Expenses

The **Expenses** tab tracks spending against the budget in the plan, in five categories: Food, Transport, Ticketing, Add-ons and Hotels.

- **Add:** tap **+ Add expense**, tap **+ ¥** on any item with a cost in the day plans (pre-filled with the category and the matching planned cost), or tap **Log** on a planned cost.
- **Totals:** spent vs planned overall and per category (tap a category to filter the list), in CNY with the SGD equivalent. Tap the rate to change it.
- **Who paid:** each expense records who paid; the tab shows who owes whom for a 50/50 split.
- Each phone remembers who last paid on it, so it defaults to its owner.

## How it works

- **Private itinerary:** this repo is public, so the itinerary is committed only as `plan.enc.json`, encrypted with the trip passphrase (AES-256-GCM, key from PBKDF2-SHA256). The app decrypts it on the phone.
- **Firebase:** uses the same Firebase project as CFA Flashcards (`firebase-config.js`), under its existing rules: each signed-in account reads and writes only its own data. No console changes needed.
- **Offline:** the app, the plan and the tickets are kept on the phone, so they open without signal. Syncing between phones needs a connection that reaches Google (roaming or a travel eSIM in China).
- **Updating the plan:** ask Claude in a session on this repo and give it the passphrase. It edits the plan with `scripts/trip_plan.py` and pushes; the app picks it up next time it opens online.

## Files

| File | Purpose |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | The app |
| `plan.enc.json` | The encrypted itinerary |
| `scripts/trip_plan.py` | Encrypts and decrypts the itinerary |
| `firebase-config.js` | Firebase project settings (not secret) |
| `manifest.webmanifest`, `sw.js`, `icons/` | Home Screen install and offline support |
