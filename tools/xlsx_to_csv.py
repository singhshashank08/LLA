#!/usr/bin/env python3
"""Convert the funnel export (xlsx) to a CSV ready for File > Import in Google Sheets.

Usage:
    python3 tools/xlsx_to_csv.py data.xlsx                 # -> data_funnel_dropoffs.csv
    python3 tools/xlsx_to_csv.py data.xlsx -o out.csv --sheet funnel_dropoffs

- Keeps every column and the header row (the Apps Script reads columns by header name).
- Dates -> YYYY-MM-DD, booleans -> TRUE/FALSE, phone -> digits only (no 1.87e10 scientific notation),
  whole-number floats (e.g. got_esim 1.0) -> 1, blanks stay blank.
- Runs locally only; nothing is uploaded. The CSV contains customer contact details: handle accordingly.
Requires: pandas, openpyxl  (pip install pandas openpyxl)
"""
import argparse
import math
import os
import sys

import pandas as pd


def clean(v, col):
    if v is None or (isinstance(v, float) and math.isnan(v)) or v is pd.NaT:
        return ""
    if isinstance(v, (pd.Timestamp,)) or hasattr(v, "strftime"):
        return v.strftime("%Y-%m-%d")
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if col == "phone":
        try:
            return str(int(float(v)))
        except (TypeError, ValueError):
            return "".join(ch for ch in str(v) if ch.isdigit())
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v).strip()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("xlsx")
    ap.add_argument("-o", "--out")
    ap.add_argument("--sheet", default="funnel_dropoffs")
    a = ap.parse_args()
    df = pd.read_excel(a.xlsx, sheet_name=a.sheet)
    for c in df.columns:
        if df[c].dtype == bool:
            df[c] = df[c].astype(object)
    out = df.copy().astype(object)
    for c in df.columns:
        out[c] = [clean(v, c) for v in df[c].tolist()]
    path = a.out or os.path.splitext(a.xlsx)[0] + "_" + a.sheet + ".csv"
    out.to_csv(path, index=False, encoding="utf-8")
    req = {"user_pseudo_id", "outcome", "max_stage", "completed", "first_seen_date"}
    missing = req - set(df.columns)
    print(f"wrote {path}: {len(out)} rows x {len(out.columns)} cols")
    if missing:
        print("WARNING: missing required columns for the dashboard:", ", ".join(sorted(missing)), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
