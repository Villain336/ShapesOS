// Marketr CRM — filter toolbar (reference: rich filter row above the table).
"use client";

import { Search, Download, Plus, Upload, Filter } from "lucide-react";
import type { CrmStage } from "./types";
import { SOURCE_LABELS } from "./types";
import { btnGhostSm, btnPrimarySm, inputCls, selectCls } from "./ui";

export interface LeadFilters {
  q: string;
  stage: string;
  owner: string;
  source: string;
  scoreBand: string;
  activeWithinDays: string;
  sort: string;
  starred: boolean;
}

export const DEFAULT_FILTERS: LeadFilters = {
  q: "", stage: "", owner: "", source: "", scoreBand: "",
  activeWithinDays: "", sort: "recent", starred: false,
};

export function FilterToolbar({
  filters, setFilters, stages, owners,
  onNewLead, onImport, onExport,
}: {
  filters: LeadFilters;
  setFilters: (f: LeadFilters) => void;
  stages: CrmStage[];
  owners: string[];
  onNewLead: () => void;
  onImport: () => void;
  onExport: () => void;
}) {
  const set = (k: keyof LeadFilters, v: string | boolean) =>
    setFilters({ ...filters, [k]: v });
  const selectSm = `${selectCls} max-w-[150px] py-[6px]! text-[12.5px]!`;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative">
        <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
        <input
          className={`${inputCls} pl-8 w-[220px] py-[6px]! text-[12.5px]!`}
          placeholder="Search name, email, company…"
          value={filters.q}
          onChange={(e) => set("q", e.target.value)}
        />
      </div>
      <select className={selectSm} value={filters.stage} onChange={(e) => set("stage", e.target.value)}>
        <option value="">Stage: Any</option>
        {stages.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
      </select>
      <select className={selectSm} value={filters.owner} onChange={(e) => set("owner", e.target.value)}>
        <option value="">Owner: All</option>
        {owners.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
      <select className={selectSm} value={filters.source} onChange={(e) => set("source", e.target.value)}>
        <option value="">Source: Any</option>
        {Object.entries(SOURCE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
      <select className={selectSm} value={filters.scoreBand} onChange={(e) => set("scoreBand", e.target.value)}>
        <option value="">Score: Any</option>
        <option value="hot">Hot (70+)</option>
        <option value="warm">Warm (40–69)</option>
        <option value="cold">Cold (&lt;40)</option>
      </select>
      <select className={selectSm} value={filters.activeWithinDays} onChange={(e) => set("activeWithinDays", e.target.value)}>
        <option value="">Activity: Any time</option>
        <option value="7">Active: 7 days</option>
        <option value="30">Active: 30 days</option>
        <option value="90">Active: 90 days</option>
      </select>
      <select className={selectSm} value={filters.sort} onChange={(e) => set("sort", e.target.value)}>
        <option value="recent">Sort: Recent</option>
        <option value="score">Sort: Score</option>
        <option value="value">Sort: Value</option>
      </select>
      <button
        className={`${btnGhostSm} ${filters.starred ? "bg-canvas!" : ""}`}
        onClick={() => set("starred", !filters.starred)}
        title="Starred only"
      >
        <Filter size={14} /> Starred
      </button>
      <div className="ml-auto flex items-center gap-2">
        <button className={btnGhostSm} onClick={onImport}>
          <Upload size={14} /> Import
        </button>
        <button className={btnGhostSm} onClick={onExport}>
          <Download size={14} /> Export
        </button>
        <button className={btnPrimarySm} onClick={onNewLead}>
          <Plus size={14} strokeWidth={2.5} /> New Lead
        </button>
      </div>
    </div>
  );
}
