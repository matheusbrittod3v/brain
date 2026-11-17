"use client";

import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown, Inbox, Search } from "lucide-react";
import { useState, type ReactNode } from "react";
import { EmptyState } from "./UiPrimitives";

export function DataTable<T>({
  data,
  columns,
  searchPlaceholder = "Filtrar...",
  onRowClick,
  emptyText = "Nenhum registro encontrado.",
  toolbar,
  pageSize = 15,
  hideSearch
}: {
  data: T[];
  columns: ColumnDef<T, unknown>[];
  searchPlaceholder?: string;
  onRowClick?: (row: T) => void;
  emptyText?: string;
  /** Extra controls rendered at the right of the search input */
  toolbar?: ReactNode;
  pageSize?: number;
  hideSearch?: boolean;
}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");

  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter },
    initialState: { pagination: { pageSize } },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel()
  });

  const filteredCount = table.getFilteredRowModel().rows.length;
  const { pageIndex } = table.getState().pagination;
  const pageCount = table.getPageCount();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {(!hideSearch || toolbar) && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          {!hideSearch && (
            <div style={{ position: "relative", flex: "1 1 220px", maxWidth: 340 }}>
              <Search
                size={14}
                style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)" }}
              />
              <input
                className="noema-input"
                style={{ width: "100%", paddingLeft: 32 }}
                value={globalFilter}
                onChange={(e) => setGlobalFilter(e.target.value)}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
              />
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
              {filteredCount} {filteredCount === 1 ? "registro" : "registros"}
            </span>
            {toolbar}
          </div>
        </div>
      )}

      <div style={{ overflow: "auto", border: "1px solid var(--border-subtle)", borderRadius: 10, maxHeight: 620 }}>
        <table className="noema-table">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  const canSort = header.column.getCanSort();
                  return (
                    <th
                      key={header.id}
                      onClick={header.column.getToggleSortingHandler()}
                      style={{ cursor: canSort ? "pointer" : "default", color: sorted ? "var(--text-primary)" : undefined }}
                      aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}
                    >
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {canSort &&
                          (sorted === "asc" ? (
                            <ArrowUp size={11} />
                          ) : sorted === "desc" ? (
                            <ArrowDown size={11} />
                          ) : (
                            <ChevronsUpDown size={11} style={{ opacity: 0.5 }} />
                          ))}
                      </span>
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} style={{ borderBottom: "none" }}>
                  <EmptyState
                    icon={<Inbox size={18} />}
                    title={globalFilter ? "Nada corresponde ao filtro" : emptyText}
                    description={globalFilter ? `Nenhum resultado para "${globalFilter}".` : undefined}
                    action={
                      globalFilter ? (
                        <button className="noema-btn noema-btn-ghost noema-btn-sm" onClick={() => setGlobalFilter("")}>
                          Limpar filtro
                        </button>
                      ) : undefined
                    }
                  />
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  className={onRowClick ? "clickable" : undefined}
                  onClick={() => onRowClick?.(row.original)}
                  tabIndex={onRowClick ? 0 : undefined}
                  onKeyDown={(e) => {
                    if (onRowClick && e.key === "Enter") onRowClick(row.original);
                  }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {pageCount > 1 && (
        <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-muted)" }}>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            Página {pageIndex + 1} de {pageCount}
          </span>
          <button
            className="noema-btn noema-btn-ghost noema-btn-sm noema-btn-icon"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
            aria-label="Página anterior"
          >
            <ChevronLeft size={14} />
          </button>
          <button
            className="noema-btn noema-btn-ghost noema-btn-sm noema-btn-icon"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
            aria-label="Próxima página"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
