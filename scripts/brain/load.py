#!/usr/bin/env python3
"""
load.py — builds the BeCopenhagen analytics database from FareHarbor exports.

Reads the two detailed FareHarbor CSV exports (bookings + sales) and loads
them into a purpose-built SQLite DB with derived analytical columns, so the
brain can answer arbitrary questions with simple SQL.

Usage:
    python3 load.py <bookings.csv> <sales.csv> [--db analytics.db]

Re-run any time with fresh exports; it rebuilds the tables from scratch.
"""
import sys
import sqlite3
import argparse
import pandas as pd
import numpy as np


def money(x):
    """'DKK1,234.56' / '-DKK10.40' -> float."""
    if pd.isna(x):
        return None
    s = str(x).replace('DKK', '').replace(',', '').strip()
    if s in ('', '-'):
        return None
    neg = s.startswith('-')
    s = s.lstrip('-')
    try:
        v = float(s)
    except ValueError:
        return None
    return -v if neg else v


# Map FareHarbor's affiliate names to short channel labels, and attach the
# commission rate we actually pay so "true net" is computable.
CHANNEL_MAP = {
    'GetYourGuide - DKK - API': ('GetYourGuide', 0.30),
    'TripAdvisor Experiences/Viator - DKK - API': ('Viator', 0.20),
    'Musement - DKK - API': ('Musement/TUI', 0.20),
    'Airbnb - API': ('Airbnb', 0.20),
    'Google - DKK': ('Google', 0.20),
    'FareHarbor Distribution Network - Danish Kroner': ('FHDN', 0.20),
}


def classify_channel(affiliate, created_by):
    """Direct vs OTA. Affiliate wins; else infer from who created it."""
    if pd.notna(affiliate) and str(affiliate).strip():
        name, rate = CHANNEL_MAP.get(str(affiliate).strip(), (str(affiliate).strip(), None))
        return name, rate, 'OTA'
    cb = str(created_by).strip() if pd.notna(created_by) else ''
    if cb.lower() == 'online':
        return 'Direct/Website', 0.0, 'Direct'
    if cb.lower() in ('shop', 'walk-in'):
        return 'Shop/Walk-in', 0.0, 'Direct'
    if cb:
        return f'Staff ({cb})', 0.0, 'Direct'
    return 'Unknown', None, 'Unknown'


# Item -> product category. N-D items are bike rentals (1-D = 1 day, etc).
def classify_item(item):
    s = str(item).strip()
    if s.endswith('-D') and s[:-2].isdigit():
        return 'rental', int(s[:-2])
    if s == 'Gift Certificate':
        return 'gift_card', None
    if 'Private' in s or 'PRIVAT' in s or s.endswith('P'):
        return 'tour_private', None
    return 'tour_group', None


def load_bookings(path, con):
    df = pd.read_csv(path, skiprows=1)
    df.columns = [c.strip() for c in df.columns]

    # FareHarbor appends a grand-totals row with no Booking ID / no Item.
    # It must be dropped or it poisons every aggregate.
    df = df[df['Booking ID'].notna() & df['Item'].notna()]
    df = df[~df['Booking ID'].astype(str).str.contains('total', case=False, na=False)]

    out = pd.DataFrame()
    out['booking_id'] = df['Booking ID'].astype(str).str.lstrip('#')
    out['order_id'] = df['Order ID'].astype(str).str.lstrip('#')
    out['cancelled'] = (df['Cancelled?'].astype(str).str.strip().str.lower() == 'yes').astype(int)
    out['item'] = df['Item']

    cat = df['Item'].apply(classify_item)
    out['item_category'] = [c[0] for c in cat]
    out['rental_days'] = [c[1] for c in cat]

    # When the sale happened
    out['booked_at'] = pd.to_datetime(df['Created At Date'], errors='coerce')
    out['booked_time'] = df['Created At Time']
    out['booked_dow'] = out['booked_at'].dt.day_name()
    out['booked_hour'] = pd.to_numeric(
        df['Created At Time'].astype(str).str.slice(0, 2), errors='coerce'
    )

    # When the tour runs
    out['tour_date'] = pd.to_datetime(df['Start Date'], errors='coerce')
    out['tour_time'] = df['Start Time']
    out['tour_dow'] = out['tour_date'].dt.day_name()
    out['tour_hour'] = pd.to_numeric(
        df['Start Time'].astype(str).str.slice(0, 2), errors='coerce'
    )
    out['availability_id'] = df['Availability ID'].astype(str).str.lstrip('#')

    # Lead time: days between booking and tour
    out['lead_days'] = (out['tour_date'] - out['booked_at']).dt.days

    out['pax'] = pd.to_numeric(df['# of Pax'], errors='coerce')
    out['language'] = df['Contact Language']
    out['country'] = df['Country by phone']
    out['created_by'] = df['Created By']
    out['paid_status'] = df['Paid Status']

    ch = [classify_channel(a, c) for a, c in zip(df['Affiliate'], df['Created By'])]
    out['channel'] = [c[0] for c in ch]
    out['commission_rate'] = [c[1] for c in ch]
    out['channel_type'] = [c[2] for c in ch]
    out['affiliate_raw'] = df['Affiliate']

    for src, dst in [
        ('Subtotal', 'subtotal'), ('Total Tax', 'tax'), ('Total', 'total'),
        ('Total Paid', 'total_paid'), ('Net Revenue Collected', 'net_revenue'),
        ('Processing Fees', 'processing_fees'),
        ('Total Paid to Affiliate', 'paid_to_affiliate'),
        ('Amount Due', 'amount_due'),
    ]:
        out[dst] = df[src].apply(money) if src in df.columns else None

    # Revenue per pax — useful for price-realization questions.
    out['revenue_per_pax'] = np.where(
        out['pax'] > 0, out['total'] / out['pax'], np.nan
    )

    out.to_sql('bookings', con, if_exists='replace', index=False)
    return len(out)


def load_sales(path, con):
    df = pd.read_csv(path, skiprows=1)
    df.columns = [c.strip() for c in df.columns]

    # Drop the grand-totals row (no transaction ID).
    df = df[df['Payment or Refund ID'].notna()]

    out = pd.DataFrame()
    out['txn_id'] = df['Payment or Refund ID'].astype(str).str.lstrip('#')
    out['booking_id'] = df['Booking ID'].astype(str).str.lstrip('#')
    out['item'] = df['Item']
    out['kind'] = df['Payment or Refund']  # Payment | Refund
    out['created_at'] = pd.to_datetime(df['Created At Date'], errors='coerce')
    out['created_dow'] = out['created_at'].dt.day_name()
    out['payment_type'] = df['Payment Type']
    out['card_type'] = df['Credit Card Type']
    out['created_by'] = df['Created By']

    for src, dst in [
        ('Gross', 'gross'), ('Processing Fee', 'processing_fee'), ('Net', 'net'),
        ('Refund Gross', 'refund_gross'), ('Tax Paid', 'tax_paid'),
        ('Subtotal Paid', 'subtotal_paid'),
    ]:
        out[dst] = df[src].apply(money) if src in df.columns else None

    out['payout_date'] = pd.to_datetime(df['Payout Date'], errors='coerce')

    out.to_sql('sales', con, if_exists='replace', index=False)
    return len(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('bookings_csv')
    ap.add_argument('sales_csv')
    ap.add_argument('--db', default='analytics.db')
    args = ap.parse_args()

    con = sqlite3.connect(args.db)
    nb = load_bookings(args.bookings_csv, con)
    ns = load_sales(args.sales_csv, con)

    # Indexes for the queries the brain will actually run.
    cur = con.cursor()
    for stmt in [
        'CREATE INDEX IF NOT EXISTS ix_b_booked ON bookings(booked_at)',
        'CREATE INDEX IF NOT EXISTS ix_b_tour ON bookings(tour_date)',
        'CREATE INDEX IF NOT EXISTS ix_b_item ON bookings(item)',
        'CREATE INDEX IF NOT EXISTS ix_b_channel ON bookings(channel)',
        'CREATE INDEX IF NOT EXISTS ix_s_created ON sales(created_at)',
        'CREATE INDEX IF NOT EXISTS ix_s_booking ON sales(booking_id)',
    ]:
        cur.execute(stmt)
    con.commit()
    con.close()

    print(f'Loaded {nb} bookings and {ns} sales transactions into {args.db}')


if __name__ == '__main__':
    main()
