# Business context

This file is the brain's knowledge of how beCopenhagen actually works — the
things the raw data can't tell it. It's fed into every question.

**Whenever the brain gets something wrong, or assumes something that isn't
true, write the correction here.** It's read fresh on every question, so an
edit takes effect immediately. No restart, no redeploy.

(Product definitions live in `products.json` — edit that when you launch,
rename, or retire a product. This file is for everything else.)

---

## What we do

Guided bike tours and bike rentals in Copenhagen. Two distinct businesses
sharing one fleet:

- **Tours** — scheduled group departures (strangers buy individual seats) and
  private tours (one group books the whole thing).
- **Rentals** — bikes rented by the day. The largest product line by booking
  count, and often overlooked when people say "how's business?".

When someone asks about "tours", they usually mean group tours specifically.
When they say "the business", include rentals.

## Products at a glance

Current group tours: **A3** (architecture), **L3** (city highlights),
**F3** (food), **H3** (history). All 3 hours except F3 at 3.5.
Private versions carry a **P** suffix: A3P, L3P, F3P.
**CUSTOM** is bespoke group work, quoted individually.

**L2 was discontinued in 2026** because occupancy was ~6.6% against ~20% for
A3 and L3. Don't include it in recommendations about what to run.

Legacy codes appear throughout the history: **ESS** became L3, **ARCH**
became A3. So a question like "how is the architecture tour trending over
three years" needs ARCH + ARCH +lunch + A3 together — treating A3 alone as
the whole history would wrongly suggest the product is brand new.

## Money

- Commission by channel: **GetYourGuide takes 30%**, most other OTAs
  (Viator, Musement/TUI, Airbnb, Google, FHDN) take **20%**. Direct bookings
  cost us nothing.
- Because of that, **gross revenue by channel is misleading**. GYG gross of
  100,000 nets 70,000; the same gross direct nets 100,000. Always reason in
  true net when comparing channels.
- Prices are in DKK and include Danish VAT (25%).

## Booking patterns worth knowing

- **Sunday is the biggest day for people to BOOK.** Saturday is the biggest
  day to actually RUN tours. These are different things and it's an easy
  mistake to conflate them.
- Cancellations are very rare (~0.6%). Don't build stories on them.

## Data cautions

- **Occupancy can only be measured from the fleet data** (`fleet.*` tables),
  because a bookings export only contains departures that SOLD. Every empty
  departure is invisible to it. Counting bookings per slot and calling that
  occupancy is wrong.
- The `fleet.*` tables only go back a few months. Bookings and sales go back
  to 2023. So occupancy and guide questions cannot be answered historically,
  only recently.
- A single large CUSTOM booking can dominate a week's revenue. When a week
  looks unusually good, check whether one booking is carrying it before
  calling it a trend.

## House style for answers

Lead with the answer. Give the real numbers. Say plainly when a sample is too
small to mean anything, rather than dressing up noise as a finding. If the
data genuinely can't answer the question, say so and say what would be needed.
