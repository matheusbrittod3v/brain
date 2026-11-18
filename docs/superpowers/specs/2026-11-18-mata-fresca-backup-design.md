# Mata_Fresca filtered backup

## Intent

Create a compressed, restorable SQL snapshot of `Mata_Fresca` that keeps table definitions while limiting the dataset to recent records, so the backup is smaller and faster to transfer.

## Scope and rules

- Connect directly to MySQL at the user-provided host and port. Read credentials from environment variables; do not place secrets in the script or this document.
- Include `CREATE TABLE` definitions for all base tables.
- Leave `job_logs`, `queue_monitors`, `pulse_entries`, `raspberrys_works`, and `filament_exceptions_table` empty.
- For `movimento_manuals`, `detalhamento_apontamentos`, and `apontamento_lancamentos`, include rows where `created_at >= '2026-10-01 00:00:00'`.
- Include every row in all other base tables, including lightweight catalog tables such as `recursos`, `areas`, and `lista_atividades`, and tables without `created_at`.
- Stream rows in batches to a gzip-compressed SQL file to bound memory use.
- The export is a filtered snapshot, not a full-fidelity recovery backup. Old referenced rows can be omitted by the cutoff, so foreign-key relationships may point to rows absent from this snapshot.

## Approaches considered

- Direct Python + MySQL streaming: selected. It can introspect all tables, apply the same `created_at` rule, and write a compressed dump with bounded memory.
- Tabularis MCP pagination: rejected for bulk export because the interface returns query results in limited batches and would require many round trips.
- `mysqldump`: efficient for full table exports, but does not apply the per-table row filter consistently without generating separate custom queries.

## Implementation choices

- Python with a MySQL driver and built-in SQL escaping/quoting.
- Snapshot reads in a consistent transaction where the server/table engine supports it.
- Output a `.sql.gz` artifact in the workspace with the cutoff and timestamp in the filename.
- No changes to the production database; the script only reads it.

## Open implementation detail

The filtered dump may not contain all rows required to satisfy foreign keys. It will be labeled as an optimized, filtered snapshot and will disable FK checks during import so the exported subset can be loaded as-is.
