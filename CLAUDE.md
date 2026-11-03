# Trip Planner

Installable web app (GitHub Pages, branch `main`) for a trip, synced through the owner's Firebase project. See README.md.

## Changing the itinerary

The itinerary is in `plan.enc.json`, encrypted because the repo is public. Ask the user for the trip passphrase if you don't have it this session, then:

1. `TRIP_KEY=<passphrase> python3 scripts/trip_plan.py decrypt <scratch path outside the repo>/plan.json`
2. Edit that JSON. Days hold `items` with `at` (HH:MM China time, drives the timer), `t` (display time), `what`, `info`, `cost`, `place` (id in `places`), `bk` (id in `bookings`), `go` ({mins, buf, how}: leave-by = at − mins − buf), `fixed` (doesn't shift when running late), `warn`, `loose` (untimed). The budget is `budget` ({fx, cats, lines: [{id, name, cat, cny, date?, bk?}]}); a line with `bk` is pre-selected when logging from that booking's plan item. Keep existing ids for places, bookings, budget lines, checklist and ideas: the app stores the user's refs, ticks, tickets and expenses against them.
3. `TRIP_KEY=<passphrase> python3 scripts/trip_plan.py encrypt <same path>`, bump `CACHE` in `sw.js`, commit and push to `main`.

Never commit the plaintext plan or the passphrase, and never write trip details (names, hotels, dates, flights) anywhere else in the repo.
