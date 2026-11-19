import React, { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { apiRequest } from '../lib/api.ts';
import { downloadCsv, formatMoney } from '../lib/format.ts';
import type { Branch, Company } from '../shared/types.ts';

interface ReportsProps {
  company: Company;
  branches: Branch[];
  financials: any;
  analytics: any;
  selectedBranchId: number | null;
}

type RepTab = 'pnl' | 'bs' | 'tb' | 'consolidated' | 'profitability' | 'ratios';

export const ReportsModule: React.FC<ReportsProps> = ({
  company,
  branches,
  financials,
  analytics,
  selectedBranchId,
}) => {
  const [tab, setTab] = useState<RepTab>('pnl');
  const [consolidatedData, setConsolidatedData] = useState<any>(null);
  const [withEliminations, setWithEliminations] = useState(true);

  const loadConsolidated = async (elims = withEliminations) => {
    const data = await apiRequest<any>(`/reports/consolidated?eliminations=${elims ? 'true' : 'false'}`);
    setConsolidatedData(data);
  };

  useEffect(() => {
    if (tab === 'consolidated') {
      loadConsolidated(withEliminations);
    }
  }, [tab, withEliminations]);

  const exportTrialBalanceCsv = () => {
    const rows = (financials?.trialBalance || []).map((r: any) => [
      r.accountCode,
      r.accountName,
      r.accountType,
      r.debit,
      r.credit,
      r.netBalance,
    ]);
    downloadCsv(
      `${company.code}_trial_balance.csv`,
      ['Account Code', 'Account Name', 'Type', 'Debit', 'Credit', 'Net Balance'],
      rows
    );
  };

  const pnl = financials?.profitAndLoss;
  const bs = financials?.balanceSheet;
  const ratios = financials?.ratios;
  const cf = financials?.cashFlow;

  const tabs: Array<[RepTab, string]> = [
    ['pnl', 'Profit & Loss'],
    ['bs', 'Balance Sheet'],
    ['tb', 'Trial Balance'],
    ['consolidated', 'Group Consolidated'],
    ['profitability', 'Branch, Product & Customer'],
    ['ratios', 'Financial Ratios & Cash Flow'],
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-200 pb-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Enterprise Financial &amp; Management Reporting</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Scope: {financials?.scopeLabel || company.legalName}
            {selectedBranchId
              ? ` (Filtered to Branch: ${branches.find((b) => b.id === selectedBranchId)?.name})`
              : ' (All Branches)'}
          </p>
        </div>
        <button
          type="button"
          onClick={exportTrialBalanceCsv}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 whitespace-nowrap shrink-0"
        >
          <Download className="w-3.5 h-3.5" /> Export Trial Balance CSV
        </button>
      </div>

      <div className="flex items-center gap-1 overflow-x-auto p-1 bg-slate-100 rounded-lg">
        {tabs.map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              tab === k ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* PROFIT & LOSS */}
      {tab === 'pnl' && pnl && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">Statement of Profit &amp; Loss</h2>
            <span className="text-xs text-slate-500">{company.fiscalYearLabel}</span>
          </div>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-100">
              <tr className="bg-slate-50 text-xs font-semibold text-slate-600">
                <td className="px-5 py-2" colSpan={2}>Operating Revenue</td>
              </tr>
              {pnl.revenues.map((r: any) => (
                <tr key={r.code}>
                  <td className="px-5 py-2.5 text-slate-800">
                    <span className="num text-xs text-slate-400 mr-2">{r.code}</span>
                    {r.name}
                  </td>
                  <td className="px-5 py-2.5 num text-right text-slate-900">{formatMoney(r.amount, company.currency)}</td>
                </tr>
              ))}
              <tr className="font-semibold bg-slate-50/70">
                <td className="px-5 py-2.5 text-slate-900">Total Revenue</td>
                <td className="px-5 py-2.5 num text-right text-slate-900">{formatMoney(pnl.totalRevenue, company.currency)}</td>
              </tr>

              <tr className="bg-slate-50 text-xs font-semibold text-slate-600">
                <td className="px-5 py-2" colSpan={2}>Cost of Goods Sold (FIFO / Weighted Average)</td>
              </tr>
              {pnl.cogs.map((r: any) => (
                <tr key={r.code}>
                  <td className="px-5 py-2.5 text-slate-800">
                    <span className="num text-xs text-slate-400 mr-2">{r.code}</span>
                    {r.name}
                  </td>
                  <td className="px-5 py-2.5 num text-right text-slate-900">{formatMoney(r.amount, company.currency)}</td>
                </tr>
              ))}
              <tr className="font-semibold bg-blue-50/50">
                <td className="px-5 py-2.5 text-slate-900">Gross Profit</td>
                <td className="px-5 py-2.5 num text-right text-blue-800">{formatMoney(pnl.grossProfit, company.currency)}</td>
              </tr>

              <tr className="bg-slate-50 text-xs font-semibold text-slate-600">
                <td className="px-5 py-2" colSpan={2}>Operating Expenses</td>
              </tr>
              {pnl.operatingExpenses.map((r: any) => (
                <tr key={r.code}>
                  <td className="px-5 py-2.5 text-slate-800">
                    <span className="num text-xs text-slate-400 mr-2">{r.code}</span>
                    {r.name}
                  </td>
                  <td className="px-5 py-2.5 num text-right text-slate-900">{formatMoney(r.amount, company.currency)}</td>
                </tr>
              ))}
              <tr className="font-bold text-base bg-slate-900 text-white">
                <td className="px-5 py-3">Net Profit / (Loss)</td>
                <td className="px-5 py-3 num text-right">{formatMoney(pnl.netIncome, company.currency)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* BALANCE SHEET */}
      {tab === 'bs' && bs && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-200 bg-slate-50 font-semibold text-sm text-slate-900">
              Assets
            </div>
            <table className="w-full text-sm">
              <tbody className="divide-y divide-slate-100">
                {bs.assets.map((a: any) => (
                  <tr key={a.code}>
                    <td className="px-5 py-2.5 text-slate-800">
                      <span className="num text-xs text-slate-400 mr-2">{a.code}</span>
                      {a.name}
                    </td>
                    <td className="px-5 py-2.5 num text-right text-slate-900">{formatMoney(a.amount, company.currency)}</td>
                  </tr>
                ))}
                <tr className="font-bold bg-slate-900 text-white">
                  <td className="px-5 py-3">Total Assets</td>
                  <td className="px-5 py-3 num text-right">{formatMoney(bs.totalAssets, company.currency)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-200 bg-slate-50 font-semibold text-sm text-slate-900">
              Liabilities &amp; Shareholders&apos; Equity
            </div>
            <table className="w-full text-sm">
              <tbody className="divide-y divide-slate-100">
                {bs.liabilities.map((l: any) => (
                  <tr key={l.code}>
                    <td className="px-5 py-2.5 text-slate-800">
                      <span className="num text-xs text-slate-400 mr-2">{l.code}</span>
                      {l.name}
                    </td>
                    <td className="px-5 py-2.5 num text-right text-slate-900">{formatMoney(l.amount, company.currency)}</td>
                  </tr>
                ))}
                {bs.equity.map((e: any) => (
                  <tr key={e.code}>
                    <td className="px-5 py-2.5 text-slate-800">
                      <span className="num text-xs text-slate-400 mr-2">{e.code}</span>
                      {e.name}
                    </td>
                    <td className="px-5 py-2.5 num text-right text-slate-900">{formatMoney(e.amount, company.currency)}</td>
                  </tr>
                ))}
                <tr>
                  <td className="px-5 py-2.5 text-slate-800 font-medium">Current Period Net Profit / (Loss)</td>
                  <td className="px-5 py-2.5 num text-right font-medium text-emerald-700">
                    {formatMoney(bs.currentNetIncome, company.currency)}
                  </td>
                </tr>
                <tr className="font-bold bg-slate-900 text-white">
                  <td className="px-5 py-3">Total Liabilities &amp; Equity</td>
                  <td className="px-5 py-3 num text-right">{formatMoney(bs.totalLiabilitiesAndEquity, company.currency)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TRIAL BALANCE */}
      {tab === 'tb' && financials && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-left text-xs font-medium text-slate-500">
                <th className="px-4 py-2.5">Code</th>
                <th className="px-4 py-2.5">Account Name</th>
                <th className="px-4 py-2.5">Type</th>
                <th className="px-4 py-2.5 text-right">Total Debit</th>
                <th className="px-4 py-2.5 text-right">Total Credit</th>
                <th className="px-4 py-2.5 text-right">Net Balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {financials.trialBalance.map((row: any) => (
                <tr key={row.accountCode} className="hover:bg-slate-50">
                  <td className="px-4 py-2 num font-medium text-slate-700">{row.accountCode}</td>
                  <td className="px-4 py-2 text-slate-900">{row.accountName}</td>
                  <td className="px-4 py-2 text-xs text-slate-500">{row.accountType}</td>
                  <td className="px-4 py-2 num text-right">{formatMoney(row.debit, company.currency)}</td>
                  <td className="px-4 py-2 num text-right">{formatMoney(row.credit, company.currency)}</td>
                  <td className="px-4 py-2 num text-right font-medium text-slate-900">
                    {formatMoney(row.netBalance, company.currency)}
                  </td>
                </tr>
              ))}
              <tr className="font-bold bg-slate-900 text-white">
                <td className="px-4 py-3" colSpan={3}>Trial Balance Total ({financials.isBalanced ? 'BALANCED' : 'UNBALANCED'})</td>
                <td className="px-4 py-3 num text-right">{formatMoney(financials.totalTrialDebit, company.currency)}</td>
                <td className="px-4 py-3 num text-right">{formatMoney(financials.totalTrialCredit, company.currency)}</td>
                <td className="px-4 py-3 num text-right">0.00</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* GROUP CONSOLIDATED STATEMENTS */}
      {tab === 'consolidated' && (
        <div className="space-y-5">
          <div className="bg-white border border-slate-200 rounded-lg p-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                {consolidatedData?.consolidated?.scopeLabel || 'Group Consolidated Statements'}
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Aggregates all legally independent entities authorized for your user role, with inter-company elimination entries.
              </p>
            </div>
            <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-800 cursor-pointer">
              <input
                type="checkbox"
                checked={withEliminations}
                onChange={(e) => setWithEliminations(e.target.checked)}
              />
              Apply Inter-Company Elimination Entries
            </label>
          </div>

          {consolidatedData && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="bg-white border border-slate-200 rounded-lg p-4">
                  <div className="text-xs text-slate-500">Consolidated Revenue</div>
                  <div className="num text-xl font-bold text-slate-900 mt-1">
                    {formatMoney(consolidatedData.consolidated.profitAndLoss.totalRevenue, company.currency)}
                  </div>
                </div>
                <div className="bg-white border border-slate-200 rounded-lg p-4">
                  <div className="text-xs text-slate-500">Consolidated Net Income</div>
                  <div className="num text-xl font-bold text-emerald-700 mt-1">
                    {formatMoney(consolidatedData.consolidated.profitAndLoss.netIncome, company.currency)}
                  </div>
                </div>
                <div className="bg-white border border-slate-200 rounded-lg p-4">
                  <div className="text-xs text-slate-500">Consolidated Assets</div>
                  <div className="num text-xl font-bold text-slate-900 mt-1">
                    {formatMoney(consolidatedData.consolidated.balanceSheet.totalAssets, company.currency)}
                  </div>
                </div>
                <div className="bg-white border border-slate-200 rounded-lg p-4">
                  <div className="text-xs text-slate-500">Consolidated Cash</div>
                  <div className="num text-xl font-bold text-blue-700 mt-1">
                    {formatMoney(consolidatedData.consolidated.cashFlow.endingCashBalance, company.currency)}
                  </div>
                </div>
              </div>

              <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
                <div className="px-5 py-3 border-b border-slate-200 text-sm font-semibold text-slate-900">
                  Entity-by-Entity Contribution Matrix
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-left text-xs text-slate-500">
                      <th className="px-4 py-2.5">Legal Entity</th>
                      <th className="px-4 py-2.5 text-right">Revenue</th>
                      <th className="px-4 py-2.5 text-right">Gross Profit</th>
                      <th className="px-4 py-2.5 text-right">Net Profit</th>
                      <th className="px-4 py-2.5 text-right">Total Assets</th>
                      <th className="px-4 py-2.5 text-right">Cash Balance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {consolidatedData.entityBreakdown.map((e: any) => (
                      <tr key={e.companyId} className="hover:bg-slate-50">
                        <td className="px-4 py-2.5 font-medium text-slate-900">
                          <span className="num text-xs text-slate-400 mr-2">{e.code}</span>
                          {e.legalName}
                        </td>
                        <td className="px-4 py-2.5 num text-right">{formatMoney(e.revenue, company.currency)}</td>
                        <td className="px-4 py-2.5 num text-right">{formatMoney(e.grossProfit, company.currency)}</td>
                        <td className="px-4 py-2.5 num text-right font-medium text-emerald-700">
                          {formatMoney(e.netIncome, company.currency)}
                        </td>
                        <td className="px-4 py-2.5 num text-right">{formatMoney(e.totalAssets, company.currency)}</td>
                        <td className="px-4 py-2.5 num text-right">{formatMoney(e.endingCash, company.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* BRANCH, PRODUCT, CUSTOMER & DEPARTMENT PROFITABILITY */}
      {tab === 'profitability' && analytics && (
        <div className="space-y-6">
          <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
            <div className="px-5 py-3 border-b border-slate-200 text-sm font-semibold text-slate-900">
              Branch-Wise Profit &amp; Loss and Inventory Holding
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-left text-xs text-slate-500">
                  <th className="px-4 py-2.5">Branch</th>
                  <th className="px-4 py-2.5">Type · City</th>
                  <th className="px-4 py-2.5 text-right">Revenue</th>
                  <th className="px-4 py-2.5 text-right">COGS</th>
                  <th className="px-4 py-2.5 text-right">OpEx</th>
                  <th className="px-4 py-2.5 text-right">Net Profit</th>
                  <th className="px-4 py-2.5 text-right">Stock Value</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {analytics.branchComparison.map((b: any) => (
                  <tr key={b.branchId}>
                    <td className="px-4 py-2.5 font-medium text-slate-900">
                      <span className="num text-xs text-slate-400 mr-1.5">{b.code}</span>
                      {b.name}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-slate-500">
                      {b.branchType} · {b.city}
                    </td>
                    <td className="px-4 py-2.5 num text-right">{formatMoney(b.revenue, company.currency)}</td>
                    <td className="px-4 py-2.5 num text-right">{formatMoney(b.cogs, company.currency)}</td>
                    <td className="px-4 py-2.5 num text-right">{formatMoney(b.expenses, company.currency)}</td>
                    <td
                      className={`px-4 py-2.5 num text-right font-semibold ${
                        b.netProfit >= 0 ? 'text-emerald-700' : 'text-red-700'
                      }`}
                    >
                      {formatMoney(b.netProfit, company.currency)}
                    </td>
                    <td className="px-4 py-2.5 num text-right text-slate-700">
                      {formatMoney(b.inventoryValue, company.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
              <div className="px-5 py-3 border-b border-slate-200 text-sm font-semibold text-slate-900">
                Product-Wise Profitability
              </div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-500">
                    <th className="px-3 py-2">Product</th>
                    <th className="px-3 py-2 text-right">Sold</th>
                    <th className="px-3 py-2 text-right">Revenue</th>
                    <th className="px-3 py-2 text-right">Margin %</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {analytics.productProfitability.map((p: any) => (
                    <tr key={p.sku}>
                      <td className="px-3 py-2 font-medium text-slate-900">{p.name}</td>
                      <td className="px-3 py-2 num text-right">{p.unitsSold}</td>
                      <td className="px-3 py-2 num text-right">{formatMoney(p.revenue, company.currency)}</td>
                      <td className="px-3 py-2 num text-right font-semibold text-emerald-700">{p.marginPct}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
              <div className="px-5 py-3 border-b border-slate-200 text-sm font-semibold text-slate-900">
                Customer Profitability &amp; User Posting Volume
              </div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-500">
                    <th className="px-3 py-2">Customer</th>
                    <th className="px-3 py-2 text-right">Bills</th>
                    <th className="px-3 py-2 text-right">Revenue</th>
                    <th className="px-3 py-2 text-right">Gross Profit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {analytics.customerProfitability.map((c: any) => (
                    <tr key={c.code}>
                      <td className="px-3 py-2 font-medium text-slate-900">{c.name}</td>
                      <td className="px-3 py-2 num text-right">{c.invoiceCount}</td>
                      <td className="px-3 py-2 num text-right">{formatMoney(c.revenue, company.currency)}</td>
                      <td className="px-3 py-2 num text-right font-semibold text-emerald-700">
                        {formatMoney(c.grossProfit, company.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* FINANCIAL RATIOS & CASH FLOW */}
      {tab === 'ratios' && ratios && cf && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-200 text-sm font-semibold text-slate-900">
              Key Financial Ratios
            </div>
            <table className="w-full text-sm">
              <tbody className="divide-y divide-slate-100">
                {[
                  ['Current Ratio (Liquidity)', `${ratios.currentRatio}x`],
                  ['Quick / Acid-Test Ratio', `${ratios.quickRatio}x`],
                  ['Gross Profit Margin', `${ratios.grossMarginPct}%`],
                  ['Net Profit Margin', `${ratios.netMarginPct}%`],
                  ['Debt-to-Equity Ratio', `${ratios.debtToEquity}x`],
                  ['Inventory Turnover', `${ratios.inventoryTurnover}x`],
                  ['Return on Assets (ROA)', `${ratios.returnOnAssetsPct}%`],
                ].map(([label, val]) => (
                  <tr key={label}>
                    <td className="px-5 py-2.5 text-slate-700">{label}</td>
                    <td className="px-5 py-2.5 num text-right font-semibold text-slate-900">{val}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-200 text-sm font-semibold text-slate-900">
              Cash Flow Summary
            </div>
            <table className="w-full text-sm">
              <tbody className="divide-y divide-slate-100">
                <tr>
                  <td className="px-5 py-2.5 text-slate-700">Cash Flow from Operating Activities</td>
                  <td className="px-5 py-2.5 num text-right font-medium text-slate-900">
                    {formatMoney(cf.operatingCashFlow, company.currency)}
                  </td>
                </tr>
                <tr>
                  <td className="px-5 py-2.5 text-slate-700">Cash Flow from Investing Activities</td>
                  <td className="px-5 py-2.5 num text-right font-medium text-slate-900">
                    {formatMoney(cf.investingCashFlow, company.currency)}
                  </td>
                </tr>
                <tr>
                  <td className="px-5 py-2.5 text-slate-700">Cash Flow from Financing Activities</td>
                  <td className="px-5 py-2.5 num text-right font-medium text-slate-900">
                    {formatMoney(cf.financingCashFlow, company.currency)}
                  </td>
                </tr>
                <tr className="font-bold bg-slate-900 text-white">
                  <td className="px-5 py-3">Ending Cash &amp; Bank Balance</td>
                  <td className="px-5 py-3 num text-right">{formatMoney(cf.endingCashBalance, company.currency)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
