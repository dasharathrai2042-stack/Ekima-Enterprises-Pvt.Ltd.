import React from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AlertTriangle, CheckCircle2, ShieldAlert } from 'lucide-react';
import { formatMoney, formatShortMoney } from '../lib/format.ts';
import type { Company, InventoryItem, JournalEntry } from '../shared/types.ts';

interface DashboardProps {
  company: Company;
  financials: any;
  analytics: any;
  journals: JournalEntry[];
  items: InventoryItem[];
  onNavigate: (section: string) => void;
}

export const DashboardModule: React.FC<DashboardProps> = ({
  company,
  financials,
  analytics,
  journals,
  items,
  onNavigate,
}) => {
  const pendingApprovals = journals.filter((j) => j.status === 'PENDING_APPROVAL');
  const reorderItems = items.filter((i) => (i.onHandQty || 0) <= i.reorderLevel);

  const pnl = financials?.profitAndLoss;
  const bs = financials?.balanceSheet;
  const cf = financials?.cashFlow;
  const ratios = financials?.ratios;

  return (
    <div className="space-y-6">
      {/* Executive Header */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-3 border-b border-slate-200 pb-4">
        <div>
          <p className="text-xs font-medium text-slate-500">
            {company.code} · {company.taxIdLabel} {company.panVatNumber} · {company.fiscalYearLabel}
          </p>
          <h1 className="text-2xl font-bold text-slate-900 mt-1">{company.legalName}</h1>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700">
            <CheckCircle2 className="w-4 h-4" />
            {financials?.isBalanced ? 'Trial Balance Verified (0.00 diff)' : 'Trial Balance Unbalanced'}
          </span>
          <span className="text-slate-300">|</span>
          <span className="text-slate-600">
            BS Equation Variance:{' '}
            <strong className="num text-slate-900">
              {formatMoney(bs?.balanceSheetDiff || 0, company.currency)}
            </strong>
          </span>
        </div>
      </div>

      {/* 4-Column Financial KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs font-medium text-slate-500">Total Revenue (YTD)</div>
          <div className="num text-2xl font-semibold text-slate-900 mt-1.5">
            {formatShortMoney(pnl?.totalRevenue, company.currency)}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            Gross Margin <span className="num font-medium text-slate-700">{ratios?.grossMarginPct ?? 0}%</span>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs font-medium text-slate-500">Net Profit / (Loss)</div>
          <div
            className={`num text-2xl font-semibold mt-1.5 ${
              (pnl?.netIncome || 0) >= 0 ? 'text-emerald-700' : 'text-red-700'
            }`}
          >
            {formatShortMoney(pnl?.netIncome, company.currency)}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            Net Margin <span className="num font-medium text-slate-700">{ratios?.netMarginPct ?? 0}%</span>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs font-medium text-slate-500">Total Assets</div>
          <div className="num text-2xl font-semibold text-slate-900 mt-1.5">
            {formatShortMoney(bs?.totalAssets, company.currency)}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            Current Ratio <span className="num font-medium text-slate-700">{ratios?.currentRatio ?? 0}x</span> · ROA{' '}
            <span className="num font-medium text-slate-700">{ratios?.returnOnAssetsPct ?? 0}%</span>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs font-medium text-slate-500">Cash &amp; Bank Liquidity</div>
          <div className="num text-2xl font-semibold text-blue-700 mt-1.5">
            {formatShortMoney(cf?.endingCashBalance, company.currency)}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            Debt / Equity <span className="num font-medium text-slate-700">{ratios?.debtToEquity ?? 0}x</span>
          </div>
        </div>
      </div>

      {/* Charts Row: Branch Comparison & 4-Month Cash Flow Forecast */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Branch Performance Comparison</h2>
              <p className="text-xs text-slate-500">Revenue, operating cost &amp; net profit by branch</p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('reports')}
              className="text-xs font-medium text-blue-700 hover:underline whitespace-nowrap shrink-0"
            >
              Full Report
            </button>
          </div>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={analytics?.branchComparison || []} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="code" tick={{ fontSize: 12, fill: '#475569' }} />
                <YAxis tick={{ fontSize: 11, fill: '#475569' }} tickFormatter={(v) => `${(v / 1000000).toFixed(1)}M`} />
                <Tooltip formatter={(value: any) => formatMoney(Number(value), company.currency)} />
                <Bar dataKey="revenue" name="Revenue" fill="#1d4ed8" radius={[4, 4, 0, 0]} />
                <Bar dataKey="netProfit" name="Net Profit" fill="#15803d" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">4-Month Cash Flow Forecast</h2>
              <p className="text-xs text-slate-500">Projected liquidity incorporating open AR/AP settlements</p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('reports')}
              className="text-xs font-medium text-blue-700 hover:underline whitespace-nowrap shrink-0"
            >
              Cash Flow Statement
            </button>
          </div>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={analytics?.cashFlowForecast || []} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="period" tick={{ fontSize: 12, fill: '#475569' }} />
                <YAxis tick={{ fontSize: 11, fill: '#475569' }} tickFormatter={(v) => `${(v / 1000000).toFixed(1)}M`} />
                <Tooltip formatter={(value: any) => formatMoney(Number(value), company.currency)} />
                <Area
                  type="monotone"
                  dataKey="projectedCash"
                  name="Projected Cash"
                  stroke="#0f172a"
                  fill="#dbeafe"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Actionable Operational Queues: Approvals & Reorder Alerts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-200">
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-amber-700" />
              <h3 className="text-sm font-semibold text-slate-900">
                Pending Approval Queue ({pendingApprovals.length})
              </h3>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('accounting')}
              className="text-xs font-medium text-blue-700 hover:underline"
            >
              Review in Accounting
            </button>
          </div>
          {pendingApprovals.length === 0 ? (
            <div className="p-5 text-sm text-slate-500">All high-value vouchers are approved and posted.</div>
          ) : (
            <div className="divide-y divide-slate-100">
              {pendingApprovals.map((je) => (
                <div key={je.id} className="px-5 py-3 flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-medium text-slate-900">{je.description}</div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      <span className="num">{je.entryNumber}</span> · Prepared by {je.createdByName} · {je.entryDate}
                    </div>
                  </div>
                  <div className="num text-sm font-semibold text-amber-700 whitespace-nowrap">
                    {formatMoney(je.totalAmount, company.currency)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-200">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-700" />
              <h3 className="text-sm font-semibold text-slate-900">
                Inventory Reorder Alerts ({reorderItems.length})
              </h3>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('inventory')}
              className="text-xs font-medium text-blue-700 hover:underline"
            >
              Open Reorder Plan
            </button>
          </div>
          {reorderItems.length === 0 ? (
            <div className="p-5 text-sm text-slate-500">All inventory SKUs are above safety reorder thresholds.</div>
          ) : (
            <div className="divide-y divide-slate-100">
              {reorderItems.map((it) => (
                <div key={it.id} className="px-5 py-3 flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-medium text-slate-900">{it.name}</div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      <span className="num">{it.sku}</span> · Reorder Level: {it.reorderLevel} {it.unit} · Suggested Order: {it.reorderQty} {it.unit}
                    </div>
                  </div>
                  <div className="num text-sm font-semibold text-red-700 whitespace-nowrap">
                    {it.onHandQty ?? 0} {it.unit}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
