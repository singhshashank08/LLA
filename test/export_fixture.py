#!/usr/bin/env python3
"""Export data.xlsx to JSON fixtures for the Node mock test (local only; output contains PII -> /tmp).
Writes:
  <out>/sheet_typed.json   : 2-D array like Range.getValues() (dates tagged, numbers, booleans, '' blanks)
  <out>/expected_rows.json : rows exactly as the original build.py produces them
"""
import json, math, sys, os
import pandas as pd
xlsx = sys.argv[1] if len(sys.argv) > 1 else '/workspace/data.xlsx'
out = sys.argv[2] if len(sys.argv) > 2 else '/tmp/fd_fixture'
os.makedirs(out, exist_ok=True)
df = pd.read_excel(xlsx, sheet_name='funnel_dropoffs')

def cell(v):
    if v is None or (isinstance(v, float) and math.isnan(v)) or v is pd.NaT: return ''
    if isinstance(v, pd.Timestamp): return {'__date__': v.strftime('%Y-%m-%dT%H:%M:%S')}
    if hasattr(v, 'item'): v = v.item()
    return v
grid = [list(df.columns)] + [[cell(v) for v in r] for r in df.itertuples(index=False)]
json.dump(grid, open(f'{out}/sheet_typed.json', 'w'))

# --- verbatim build.py row mapping ---
def s(x):
    if x is None or (isinstance(x, float) and math.isnan(x)): return ''
    return str(x).strip()
def ph(x):
    if x is None or (isinstance(x, float) and math.isnan(x)): return ''
    return '+' + str(int(x))
rows = []
for r in df.itertuples(index=False):
    rows.append(dict(id=s(r.user_pseudo_id), name=s(r.name), email=s(r.email), phone=ph(r.phone),
      country=s(r.country_code), platform=s(r.platform), login=s(r.login_method), path=s(r.path),
      outcome=s(r.outcome), ms=int(r.max_stage), last=s(r.last_stage), drop=s(r.drop_stage),
      done=bool(r.completed), purch=bool(r.purchased), esim=('' if pd.isna(r.got_esim) else int(r.got_esim)),
      lfs=s(r.last_funnel_screen), fs=r.first_seen_date.strftime('%Y-%m-%d'), le=r.last_event_date.strftime('%Y-%m-%d'),
      sv=int(r.screen_views), ad=int(r.active_days), imp=int(r.personal_stage_imputed), cfg=s(r.corrected_config), lang=s(r.user_language)))
json.dump(rows, open(f'{out}/expected_rows.json', 'w'))
print('fixtures ->', out, len(rows), 'rows')
