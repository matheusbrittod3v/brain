# Mata_Fresca Filtered Backup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a compressed, restorable SQL snapshot of `Mata_Fresca` with the agreed `created_at` cutoff.

**Architecture:** A standalone Python script connects directly to MySQL with environment-provided credentials, introspects base tables, writes schema, and streams qualifying rows in bounded batches to gzip. The generated artifact is local and the production database is read-only to this script.

**Tech Stack:** Python 3, PyMySQL, gzip, MySQL.

**Spec:** `docs/superpowers/specs/2026-11-18-mata-fresca-backup-design.md`

## Global Constraints

- Use the database `Mata_Fresca` on the user-provided host and port.
- Never write credentials into source or documentation.
- Leave `job_logs`, `queue_monitors`, `pulse_entries`, `raspberrys_works`, and `filament_exceptions_table` empty.
- For `movimento_manuals`, `detalhamento_apontamentos`, and `apontamento_lancamentos`, include records where `created_at >= '2026-10-01 00:00:00'`.
- Include all rows in every other base table, including tables without `created_at`.
- Stream records to a gzip-compressed SQL dump in bounded batches.
- The script must not modify the production database.

## Review Focus

- Missing credentials: fail before creating a partial artifact and name the required environment variable keys.
- Tables outside the date-filter list: include complete table rows, regardless of `created_at`.
- Excluded tables: emit DDL and no inserts regardless of their `created_at` values.
- Integer `created_at`: interpret the value as Unix seconds and compute the matching cutoff.
- Interrupted stream or disk error: remove the incomplete temporary artifact and leave any prior completed dump untouched.

---

### Task 1: Build and run the filtered dump utility

**Files:**
- Create: `scripts/backup_mata_fresca.py`
- Create: `requirements-backup.txt`
- Create: `backups/Mata_Fresca_created_at_2026-10-01_20261118.sql.gz`

**Interfaces:**
- Environment: `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`.
- CLI: `python scripts/backup_mata_fresca.py [--output PATH] [--batch-size N]`.
- Default output: `backups/Mata_Fresca_created_at_<run timestamp>.sql.gz`.

- [x] Implement connection validation, UTF-8 SQL quoting, `SHOW CREATE TABLE` export, and transactional streaming for each table.
- [x] Apply the explicit empty-table list and filter only the three named large tables by `created_at`; include all rows in other tables, handle integer epoch columns as Unix seconds, and omit computed columns from INSERTs.
- [x] Write to a temporary gzip file and atomically rename only after a successful close; report per-table exported row counts without exposing credentials.
- [x] Run `python -m py_compile scripts/backup_mata_fresca.py`.
- [x] Generate the requested dump and inspect it with gzip integrity checks plus SQL structure/count summaries. Confirm excluded tables have no INSERT statements and catalog tables are complete.
