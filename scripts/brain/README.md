# BeCopenhagen data brain

Ask questions about the business in plain English; Claude writes SQL against a
local analytics DB and answers with real numbers.

## Setup (once)

    pip install pandas numpy --break-system-packages

Export two DETAILED reports from FareHarbor (Custom Range 01/01/2023 -> today,
"Select: all" columns, Detailed report):
  1. Bookings report   -> bookings.csv
  2. Sales report      -> sales.csv

Then build the DB:

    python3 load.py bookings.csv sales.csv --db analytics.db

Re-run that any time with fresh exports to refresh the data.

## Ask it things

    node ask.js "do people book more on Sundays?"
    node ask.js "which channel nets us the most after commission?"
    node ask.js "what's the average lead time for A3 vs F3?"
    node ask.js "how are bike rentals trending year over year?"
    node ask.js --sql "best tour start time"     # --sql shows the query

Uses ANTHROPIC_API_KEY_REPORTS (falls back to ANTHROPIC_API_KEY).

## Known data gaps
- The bookings export contains NO cancelled bookings, so cancellation-rate
  questions can't be answered. Re-export with cancelled bookings included to
  fix.
- Availabilities that sold ZERO bookings aren't in this data (bookings-only),
  so true occupancy / empty-departure questions need the fleet DB
  (tour_availabilities) instead.
- Guide assignment isn't in these exports — that also lives in the fleet DB.
