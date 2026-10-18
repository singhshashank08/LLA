/**
 * Import.gs — how the daily data gets into the sheet (documentation only; no code runs here).
 *
 * The dashboard reads tab SHEET_NAME (default 'funnel_dropoffs') by HEADER NAME, so column order
 * does not matter and extra columns are ignored. Required headers:
 *   user_pseudo_id, outcome, max_stage, completed, first_seen_date
 * Used if present: name, email, phone, country_code, platform, login_method, path, last_stage,
 *   drop_stage, purchased, got_esim, last_funnel_screen, last_event_date, screen_views,
 *   active_days, personal_stage_imputed, corrected_config, user_language
 *
 * Pick ONE way to keep the tab fresh before REPORT_HOUR each day:
 *
 * 1) Manual paste / upload
 *    - Convert the export with tools/xlsx_to_csv.py, then File > Import > Upload >
 *      "Replace current sheet" on the funnel_dropoffs tab. Keep the header row.
 *
 * 2) IMPORTRANGE from another sheet that your pipeline writes
 *    - In A1 of funnel_dropoffs:  =IMPORTRANGE("<source spreadsheet URL>", "funnel_dropoffs!A:AF")
 *    - Approve the "Allow access" prompt once. The script reads computed values, so this just works.
 *
 * 3) BigQuery Connected Sheets (Data > Data connectors > BigQuery)
 *    - Connected-sheet *data source* tabs are not readable as normal ranges. Use "Extract" to
 *      materialise the query into a regular tab named funnel_dropoffs and schedule the
 *      extract refresh (Data > Data connectors > Refresh options) to run before REPORT_HOUR.
 *
 * 4) Separate ETL writing to the sheet (Sheets API, Zapier, etc.)
 *    - Make it overwrite the tab (header in row 1) rather than append duplicates; one row per user.
 *
 * Tips: keep phone as a number or text with digits (both normalise to '+<digits>'); dates may be
 * real dates, 'yyyy-mm-dd' text, or yyyymmdd numbers; booleans may be TRUE/FALSE, true/false, 1/0.
 * After a manual change use menu Funnel Dashboard > Refresh data cache to see it immediately
 * (otherwise viewers see it within CACHE_SECONDS, default 10 min).
 */
