import * as React from "react";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { ChevronLeft, ChevronRight, SearchX, Search } from "lucide-react";

import { cn } from "../lib/utils";
import { Button } from "./button";
import { Input } from "./input";
import { Skeleton } from "./skeleton";

/// Generic data table: client-side search, sortable columns, pagination,
/// optional row click. `data === null` renders the loading skeleton; an
/// empty array renders `empty` (a styled empty state by default).
export function DataTable<T>({
  columns,
  data,
  search,
  onRowClick,
  empty,
  searchPlaceholder = "Search…",
  toolbarActions,
  pageSize = 20,
  className,
}: {
  columns: ColumnDef<T, any>[];
  /** null = loading (skeleton), [] = empty state */
  data: T[] | null;
  /** Text a row's search must match; omit for no search box. */
  search?: (row: T) => string;
  onRowClick?: (row: T) => void;
  empty?: React.ReactNode;
  searchPlaceholder?: string;
  toolbarActions?: React.ReactNode;
  pageSize?: number;
  className?: string;
}) {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = React.useState("");

  const table = useReactTable({
    data: data ?? [],
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: search
      ? (_row, _columnId, filterValue) => {
          const needle = String(filterValue).toLowerCase();
          if (!needle) return true;
          return search(_row.original).toLowerCase().includes(needle);
        }
      : undefined,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize } },
  });

  const filteredCount = table.getFilteredRowModel().rows.length;
  const pageCount = table.getPageCount();
  const pageIndex = table.getState().pagination.pageIndex;

  return (
    <div className={cn("overflow-hidden rounded-lg border border-border bg-card", className)}>
      {(search !== undefined || toolbarActions) && (
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          {search !== undefined && (
            <div className="relative w-full max-w-xs">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
              <Input
                value={globalFilter}
                onChange={(e) => setGlobalFilter(e.target.value)}
                placeholder={searchPlaceholder}
                className="h-8 pl-8 text-sm"
              />
            </div>
          )}
          <div className="ml-auto flex items-center gap-2">{toolbarActions}</div>
        </div>
      )}
      <div className="min-h-24">
        {data === null ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full rounded-md" />
            ))}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id} className="border-b border-border">
                  {hg.headers.map((header) => {
                    const canSort = header.column.getCanSort();
                    const dir = header.column.getIsSorted();
                    return (
                      <th
                        key={header.id}
                        className={cn(
                          "px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground",
                          canSort && "cursor-pointer select-none hover:text-foreground",
                        )}
                        onClick={canSort ? header.column.getToggleSortingHandler() : undefined}
                      >
                        {header.isPlaceholder
                          ? null
                          : flexRender(header.column.columnDef.header, header.getContext())}
                        {dir === "asc" && <span className="ml-1">↑</span>}
                        {dir === "desc" && <span className="ml-1">↓</span>}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.length === 0 ? (
                <tr>
                  <td colSpan={columns.length}>
                    {empty ?? (
                      <div className="flex flex-col items-center gap-1.5 px-4 py-10 text-muted-foreground">
                        <SearchX className="size-5" />
                        <p className="text-sm">Nothing here</p>
                      </div>
                    )}
                  </td>
                </tr>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <tr
                    key={row.id}
                    onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                    className={cn(
                      "border-b border-border/60 transition-colors last:border-b-0",
                      onRowClick && "cursor-pointer hover:bg-accent/40",
                    )}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="px-3 py-2.5 align-middle">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
      </div>
      {data !== null && pageCount > 1 && (
        <div className="flex items-center justify-between border-t border-border px-3 py-2">
          <p className="text-xs text-muted-foreground tabular-nums">
            Page {pageIndex + 1} of {pageCount}
            {search !== undefined && ` · ${filteredCount} total`}
          </p>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={!table.getCanPreviousPage()}
              onClick={() => table.previousPage()}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={!table.getCanNextPage()}
              onClick={() => table.nextPage()}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
