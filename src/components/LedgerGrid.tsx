"use client";

import Link from "next/link";
import { ledgerCount } from "@/lib/ledgerCount";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AgGridReact } from "ag-grid-react";
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type CellKeyDownEvent,
  type ColDef,
  type GridApi,
  type GridReadyEvent,
  type ICellRendererParams,
  type RowClickedEvent,
} from "ag-grid-community";
import {
  csvPesos,
  csvSafe,
  IN_FLIGHT,
  isDonationRow,
  isProblemStatus,
  ledgerStatusLabel,
  ledgerTotals,
  typeLabel,
} from "@/lib/impact";
import { formatPeso } from "@/lib/money";
import type { PublicLedgerRow } from "@/server/public";
import { niceDate } from "@/lib/niceDate";

// Community edition only. No Enterprise module is registered, so none can run or show a watermark.
ModuleRegistry.registerModules([AllCommunityModule]);

const POLL_MS = 15_000;
const FIT_ROWS = 25;
const PHONE = "(max-width: 640px)";

/** The grid's look comes from the app tokens in globals.css, so the two never drift. */
const theme = themeQuartz.withParams({
  backgroundColor: "var(--surface)",
  foregroundColor: "var(--ink)",
  accentColor: "var(--main)",
  fontFamily: "var(--font-gabarito), system-ui, sans-serif",
  fontSize: 15,
  headerBackgroundColor: "var(--bg)",
  headerTextColor: "var(--ink)",
  headerFontWeight: 700,
  headerFontSize: 14,
  rowHoverColor: "var(--pale)",
  borderColor: "var(--bg)",
  columnBorder: false,
  wrapperBorder: false,
  wrapperBorderRadius: 20,
  rowHeight: 52,
  headerHeight: 48,
  spacing: 8,
  inputBorder: false,
  inputBackgroundColor: "var(--bg)",
  inputFocusBorder: { color: "var(--main)", width: 2 },
  cellHorizontalPadding: 14,
  oddRowBackgroundColor: "var(--surface)",
});

type Row = PublicLedgerRow;
type GridRow = Row;

/** A payout that has not reached the vet yet. It reads as waiting, not as money already spent. */
const isPending = (r: Row) => !isDonationRow(r) && (IN_FLIGHT as readonly string[]).includes(r.status);

function subscribe(cb: () => void) {
  const m = window.matchMedia(PHONE);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
}
const useIsPhone = () =>
  useSyncExternalStore(
    subscribe,
    () => window.matchMedia(PHONE).matches,
    () => false,
  );

function StatusTag({ status }: { status: string }) {
  return <span className={`tag ${isProblemStatus(status) ? "tag-bad" : ""}`}>{ledgerStatusLabel(status)}</span>;
}

function CatCell({ data }: ICellRendererParams<GridRow>) {
  if (!data?.cat || !data.catId) return <span className="soft">-</span>;
  return (
    <Link href={`/cats/${data.catId}`} className="font-bold text-main underline underline-offset-4">
      {data.cat}
    </Link>
  );
}

const amountText = (r: GridRow, which: "amount" | "fee") => {
  const v = which === "amount" ? r.amount : r.fee;
  if (v === null) return "";
  return !isDonationRow(r) && !isPending(r) && which === "amount" ? `-${formatPeso(v)}` : formatPeso(v);
};

function NoRows() {
  return <p className="p-4 font-bold">Nothing matches. Clear the search or a filter to see more.</p>;
}

function Detail({ row, onClose }: { row: Row | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (row && !d.open) d.showModal();
    if (!row && d.open) d.close();
    setCopied(false);
  }, [row]);

  const copy = async () => {
    if (!row?.paypalId) return;
    try {
      await navigator.clipboard.writeText(row.paypalId);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const out = row ? !isDonationRow(row) && !isPending(row) : false;
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      aria-labelledby="ledger-detail-title"
      className="m-auto max-h-[85dvh] w-[min(32rem,calc(100vw-2rem))] overflow-auto rounded-out bg-surface p-5 text-ink backdrop:bg-black/40 max-sm:mb-0 max-sm:w-full max-sm:max-w-none max-sm:rounded-b-none"
    >
      {row && (
        <>
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 id="ledger-detail-title" className="h2">
                {typeLabel(row.type)}
              </h2>
              <p className="small soft">{niceDate(row.date)}</p>
            </div>
            <p className="text-2xl font-extrabold tracking-tight">{out ? `-${formatPeso(row.amount)}` : formatPeso(row.amount)}</p>
          </div>
          <p className="mt-3 flex flex-wrap items-center gap-2">
            <StatusTag status={row.status} />
            {row.fee !== null && <span className="small soft">Fee {formatPeso(row.fee)}</span>}
          </p>
          <dl className="mt-4 grid gap-3">
            <div>
              <dt className="small soft">{out ? "Paid to" : "From"}</dt>
              <dd className="font-bold">{row.who ?? "Not recorded"}</dd>
            </div>
            {row.cat && row.catId && (
              <div>
                <dt className="small soft">Cat</dt>
                <dd>
                  <Link href={`/cats/${row.catId}`} className="font-bold text-main underline underline-offset-4">
                    {row.cat}
                  </Link>
                </dd>
              </div>
            )}
            {row.reason && (
              <div>
                <dt className="small soft">Why the treasurer did this</dt>
                <dd>{row.reason}</dd>
              </div>
            )}
            <div>
              <dt className="small soft">PayPal reference</dt>
              <dd className="flex flex-wrap items-center gap-2">
                {row.paypalId ? (
                  <>
                    <code className="break-all">{row.paypalId}</code>
                    <button type="button" onClick={copy} className="btn-quiet !min-h-11">
                      {copied ? "Copied" : "Copy"}
                    </button>
                  </>
                ) : (
                  <span className="soft">None yet. It appears once PayPal confirms.</span>
                )}
              </dd>
            </div>
          </dl>
          <button type="button" onClick={onClose} className="btn mt-5 w-full">
            Close
          </button>
        </>
      )}
    </dialog>
  );
}

export function LedgerGrid({ initial }: { initial: Row[] }) {
  const phone = useIsPhone();
  const apiRef = useRef<GridApi<GridRow> | null>(null);
  const [rows, setRows] = useState(initial);
  // Rendered only in the browser, so the address bar is there. A treasurer entry links here with ?q=its reference.
  const [quick, setQuick] = useState(() => new URLSearchParams(window.location.search).get("q") ?? "");
  const [shown, setShown] = useState<Row[]>(initial);
  const [open, setOpen] = useState<Row | null>(null);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let live = true;
    const timer = setInterval(async () => {
      try {
        const res = await fetch("/api/ledger", { cache: "no-store" });
        if (!res.ok) throw new Error("ledger");
        const body = (await res.json()) as { rows: Row[] };
        if (live) {
          setRows(body.rows);
          setStale(false);
        }
      } catch {
        if (live) setStale(true);
      }
    }, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  const columns = useMemo<ColDef<GridRow>[]>(
    () => [
      {
        colId: "date",
        headerName: "Date",
        field: "date",
        width: 118,
        sort: "desc",
        filter: !phone,
        // Sorted, filtered and exported as YYYY-MM-DD; shown as "24 Oct 2026".
        valueFormatter: (p) => (p.value ? niceDate(p.value) : ""),
        getQuickFilterText: (p) => (p.value ? `${p.value} ${niceDate(p.value)}` : ""),
        cellClass: "tabular-nums",
      },
      {
        colId: "what",
        headerName: "What",
        flex: phone ? 1 : 0,
        minWidth: 120,
        width: 130,
        valueGetter: (p) => (p.data ? typeLabel(p.data.type) : ""),
        cellRenderer: (p: ICellRendererParams<GridRow>) =>
          p.data && isPending(p.data) ? (
            <span className="flex flex-col justify-center leading-tight">
              <span>{typeLabel(p.data.type)}</span>
              <span className="text-xs font-bold text-soft">{ledgerStatusLabel(p.data.status)}</span>
            </span>
          ) : (
            typeLabel(p.data?.type ?? "")
          ),
      },
      {
        colId: "cat",
        headerName: "Cat",
        field: "cat",
        width: 130,
        hide: phone,
        cellRenderer: CatCell,
      },
      {
        colId: "amount",
        headerName: "Amount",
        filter: phone ? false : "agNumberColumnFilter",
        width: phone ? 120 : 130,
        type: "rightAligned",
        headerClass: "ag-right-aligned-header",
        valueGetter: (p) => (p.data ? p.data.amount / 100 : null),
        valueFormatter: (p) => (p.data ? amountText(p.data, "amount") : ""),
        getQuickFilterText: (p) => (p.data ? `${amountText(p.data, "amount")} ${p.data.amount / 100}` : ""),
        cellClass: (p) => (p.data && isPending(p.data) ? "tabular-nums font-bold text-soft" : "tabular-nums font-bold"),
      },
      {
        colId: "fee",
        headerName: "Fee",
        filter: phone ? false : "agNumberColumnFilter",
        width: 110,
        hide: phone,
        type: "rightAligned",
        headerClass: "ag-right-aligned-header",
        valueGetter: (p) => (p.data && p.data.fee !== null ? p.data.fee / 100 : null),
        valueFormatter: (p) => (p.data ? amountText(p.data, "fee") : ""),
        cellClass: "tabular-nums",
      },
      {
        colId: "status",
        headerName: "Status",
        width: 140,
        hide: phone,
        valueGetter: (p) => (p.data ? ledgerStatusLabel(p.data.status) : ""),
        cellRenderer: (p: ICellRendererParams<GridRow>) => (p.data ? <StatusTag status={p.data.status} /> : null),
      },
      { colId: "who", headerName: "Who", field: "who", width: 150, hide: phone },
      { colId: "reason", headerName: "Why", field: "reason", flex: 1, minWidth: 160, hide: phone },
      // Hidden on screen, still searchable and exported.
      { colId: "paypalId", headerName: "PayPal reference", field: "paypalId", hide: true },
    ],
    [phone],
  );

  const defaultColDef = useMemo<ColDef<GridRow>>(
    () => ({ sortable: true, filter: !phone, resizable: !phone, suppressMovable: true }),
    [phone],
  );

  const refresh = useCallback((api: GridApi<GridRow>) => {
    const visible: Row[] = [];
    api.forEachNodeAfterFilter((n) => n.data && visible.push(n.data));
    setShown(visible);
  }, []);

  const totals = useMemo(() => ledgerTotals(shown), [shown]);
  // A short ledger fits its rows, so no empty block sits under them; a long one scrolls inside a fixed frame.
  const fitRows = rows.length <= FIT_ROWS;

  const onReady = (e: GridReadyEvent<GridRow>) => {
    apiRef.current = e.api;
    refresh(e.api);
  };

  const openRow = (data: GridRow | undefined) => {
    if (data) setOpen(data);
  };
  const onRowClicked = (e: RowClickedEvent<GridRow>) => {
    if ((e.event?.target as HTMLElement | null)?.closest("a")) return;
    openRow(e.data);
  };
  const onCellKeyDown = (e: CellKeyDownEvent<GridRow>) => {
    const ev = e.event;
    if (!(ev instanceof KeyboardEvent) || ev.key !== "Enter") return;
    if ((ev.target as HTMLElement | null)?.closest("a")) return;
    openRow(e.data);
  };

  const exportCsv = () =>
    apiRef.current?.exportDataAsCsv({
      fileName: "stray-fund-ledger.csv",
      allColumns: true,
      processCellCallback: (p) => {
        const r = p.node?.data;
        if (!r) return "";
        switch (p.column.getColId()) {
          case "date":
            return csvSafe(r.date);
          case "amount":
            return csvPesos(r.amount);
          case "fee":
            return r.fee === null ? "" : csvPesos(r.fee);
          case "what":
            return typeLabel(r.type);
          case "status":
            return ledgerStatusLabel(r.status);
          default:
            return csvSafe(String(p.value ?? ""));
        }
      },
    });

  return (
    <section aria-label="Ledger" className="mt-5 lg:-mx-16 xl:-mx-44">
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(6.5rem,1fr))] gap-x-3 gap-y-4" aria-label="Totals">
        <div>
          <dt className="small soft">Received</dt>
          <dd className="text-lg font-extrabold tabular-nums leading-tight">{formatPeso(totals.donated)}</dd>
          <dd className="small soft max-sm:hidden">PayPal fees {formatPeso(totals.paypalFees)}</dd>
        </div>
        <div>
          <dt className="small soft">Paid to vets</dt>
          <dd className="text-lg font-extrabold tabular-nums leading-tight">{formatPeso(totals.paidToVets)}</dd>
          <dd className="small soft max-sm:hidden">Fees {formatPeso(totals.payoutFees)}</dd>
        </div>
        {totals.inFlight > 0 && (
          <div>
            <dt className="small soft">On its way</dt>
            <dd className="text-lg font-extrabold tabular-nums leading-tight">{formatPeso(totals.inFlight)}</dd>
            <dd className="small soft max-sm:hidden">Not paid yet</dd>
          </div>
        )}
      </dl>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <label className="min-w-0 flex-1 basis-56">
          <span className="sr-only">Search the ledger</span>
          <input
            type="search"
            value={quick}
            onChange={(e) => setQuick(e.target.value)}
            placeholder="Search cat, person, amount, reference"
            className="field"
            autoComplete="off"
          />
        </label>
        <button type="button" onClick={exportCsv} className="btn-quiet">
          Download CSV
        </button>
      </div>
      <p className="small soft mt-2" role="status">
        {ledgerCount(shown.length, rows.length)}
      </p>
      {stale && (
        <p role="status" className="note note-bad mt-2 font-bold">
          Could not refresh the ledger. What you see may be out of date, and we will keep trying.
        </p>
      )}
      <div className={`mt-2 max-w-full overflow-hidden rounded-out ${fitRows ? "" : "h-[clamp(24rem,calc(100dvh-15rem),36rem)]"}`}>
        <AgGridReact<GridRow>
          theme={theme}
          domLayout={fitRows ? "autoHeight" : "normal"}
          rowData={rows}
          columnDefs={columns}
          defaultColDef={defaultColDef}
          quickFilterText={quick}
          includeHiddenColumnsInQuickFilter
          onGridReady={onReady}
          onModelUpdated={(e) => refresh(e.api)}
          onRowClicked={onRowClicked}
          onCellKeyDown={onCellKeyDown}
          noRowsOverlayComponent={NoRows}
          suppressCellFocus={false}
          animateRows={false}
        />
      </div>
      <Detail row={open} onClose={() => setOpen(null)} />
    </section>
  );
}
