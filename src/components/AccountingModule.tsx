import React, { useEffect, useState } from 'react';
import { Check, Lock, Plus, Unlock, X } from 'lucide-react';
import { apiRequest, makeIdempotencyKey } from '../lib/api.ts';
import { formatMoney } from '../lib/format.ts';
import type {
  Account,
  AuthUser,
  BankStatementLine,
  Branch,
  BudgetRow,
  Company,
  CostProfitCenter,
  FiscalPeriodLock,
  JournalEntry,
} from '../shared/types.ts';

interface AccountingProps {
  company: Company;
  user: AuthUser;
  branches: Branch[];
  centers: CostProfitCenter[];
  accounts: Account[];
  journals: JournalEntry[];
  onRefresh: () => Promise<void>;
}

type AcctTab = 'journals' | 'coa' | 'gl' | 'bank' | 'budgets' | 'allocate' | 'locks';

export const AccountingModule: React.FC<AccountingProps> = ({
  company,
  user,
  branches,
  centers,
  accounts,
  journals,
  onRefresh,
}) => {
  const [subTab, setSubTab] = useState<AcctTab>('journals');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Manual JE form state
  const [jeDate, setJeDate] = useState(new Date().toISOString().slice(0, 10));
  const [jeDesc, setJeDesc] = useState('');
  const [isElimination, setIsElimination] = useState(false);
  const [jeLines, setJeLines] = useState([
    { accountId: accounts[0]?.id || 0, branchId: branches[0]?.id || 0, debit: 0, credit: 0, memo: '' },
    { accountId: accounts[1]?.id || accounts[0]?.id || 0, branchId: branches[0]?.id || 0, debit: 0, credit: 0, memo: '' },
  ]);

  // New Account state
  const [newAcct, setNewAcct] = useState({ code: '', name: '', accountType: 'EXPENSE', subType: 'OPERATING', isBankOrCash: false });

  // General Ledger state
  const [glAccountId, setGlAccountId] = useState<string>('');
  const [glRows, setGlRows] = useState<any[]>([]);

  // Bank Rec state
  const [bankData, setBankData] = useState<{ bankAccounts: any[]; activeBankId: number | null; statements: BankStatementLine[] }>({
    bankAccounts: [],
    activeBankId: null,
    statements: [],
  });
  const [stmtForm, setStmtForm] = useState({ date: new Date().toISOString().slice(0, 10), desc: '', ref: '', amount: '' });

  // Budgets & Period Locks state
  const [budgets, setBudgets] = useState<BudgetRow[]>([]);
  const [budgetForm, setBudgetForm] = useState({ accountId: accounts[0]?.id || 0, branchId: '', amount: '' });
  const [locks, setLocks] = useState<FiscalPeriodLock[]>([]);

  // Inter-Branch Expense Allocation state
  const [allocForm, setAllocForm] = useState({
    date: new Date().toISOString().slice(0, 10),
    expenseAccountId: accounts.find((a) => a.accountType === 'EXPENSE' && a.subType !== 'COGS')?.id || accounts[0]?.id || 0,
    paidFromAccountId: accounts.find((a) => a.isBankOrCash === 1)?.id || accounts[0]?.id || 0,
    totalAmount: '100000',
    description: 'Shared Head Office IT & Marketing Allocation',
    splits: branches.slice(0, 2).map((b, i) => ({ branchId: b.id, percent: i === 0 ? 60 : 40 })),
  });

  useEffect(() => {
    if (accounts.length >= 2 && jeLines[0].accountId === 0) {
      setJeLines([
        { accountId: accounts[0].id, branchId: branches[0]?.id || 0, debit: 0, credit: 0, memo: '' },
        { accountId: accounts[1].id, branchId: branches[0]?.id || 0, debit: 0, credit: 0, memo: '' },
      ]);
    }
  }, [accounts, branches]);

  useEffect(() => {
    if (branches.length >= 2) {
      const equal = Math.floor(100 / branches.length);
      const rem = 100 - equal * (branches.length - 1);
      setAllocForm((prev) => ({
        ...prev,
        expenseAccountId: accounts.find((a) => a.accountType === 'EXPENSE' && a.subType !== 'COGS')?.id || prev.expenseAccountId,
        paidFromAccountId: accounts.find((a) => a.isBankOrCash === 1)?.id || prev.paidFromAccountId,
        splits: branches.map((b, idx) => ({ branchId: b.id, percent: idx === branches.length - 1 ? rem : equal })),
      }));
    }
  }, [company.id, branches.length]);

  const loadGl = async (acctId = glAccountId) => {
    const qs = acctId ? `?accountId=${acctId}` : '';
    const rows = await apiRequest<any[]>(`/companies/${company.id}/general-ledger${qs}`);
    setGlRows(rows);
  };

  const loadBankRec = async (bankId?: number) => {
    const qs = bankId ? `?bankAccountId=${bankId}` : '';
    const data = await apiRequest<any>(`/companies/${company.id}/bank-reconciliation${qs}`);
    setBankData(data);
  };

  const loadBudgets = async () => {
    const rows = await apiRequest<BudgetRow[]>(`/companies/${company.id}/budgets`);
    setBudgets(rows);
  };

  const loadLocks = async () => {
    const rows = await apiRequest<FiscalPeriodLock[]>(`/companies/${company.id}/period-locks`);
    setLocks(rows);
  };

  useEffect(() => {
    if (subTab === 'gl') loadGl();
    if (subTab === 'bank') loadBankRec();
    if (subTab === 'budgets') loadBudgets();
    if (subTab === 'locks') loadLocks();
  }, [subTab, company.id]);

  const sumDr = jeLines.reduce((s, l) => s + Number(l.debit || 0), 0);
  const sumCr = jeLines.reduce((s, l) => s + Number(l.credit || 0), 0);
  const isJeBalanced = sumDr > 0 && Math.abs(sumDr - sumCr) < 0.005;

  const submitJournal = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const res = await apiRequest<{ entryNumber: string; status: string }>(`/companies/${company.id}/journals`, {
        method: 'POST',
        idempotencyKey: makeIdempotencyKey('je'),
        body: {
          entryDate: jeDate,
          description: jeDesc,
          isElimination,
          isIntercompany: isElimination,
          lines: jeLines,
        },
      });
      setMsg({
        kind: 'ok',
        text: `Journal ${res.entryNumber} saved with status: ${res.status}.`,
      });
      setJeDesc('');
      await onRefresh();
    } catch (err: any) {
      setMsg({ kind: 'err', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const handleDecision = async (jeId: number, decision: 'APPROVE' | 'REJECT') => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await apiRequest<{ entryNumber: string; status: string }>(
        `/companies/${company.id}/journals/${jeId}/decision`,
        { method: 'POST', body: { decision } }
      );
      setMsg({ kind: 'ok', text: `Voucher ${res.entryNumber} updated to ${res.status}.` });
      await onRefresh();
    } catch (err: any) {
      setMsg({ kind: 'err', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const submitNewAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await apiRequest(`/companies/${company.id}/accounts`, { method: 'POST', body: newAcct });
      setMsg({ kind: 'ok', text: `Account ${newAcct.code} - ${newAcct.name} added to Chart of Accounts.` });
      setNewAcct({ code: '', name: '', accountType: 'EXPENSE', subType: 'OPERATING', isBankOrCash: false });
      await onRefresh();
    } catch (err: any) {
      setMsg({ kind: 'err', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const togglePeriodLock = async (lockId: number) => {
    setBusy(true);
    setMsg(null);
    try {
      await apiRequest(`/companies/${company.id}/period-locks/${lockId}/toggle`, { method: 'POST' });
      await loadLocks();
      setMsg({ kind: 'ok', text: 'Financial period lock status updated.' });
    } catch (err: any) {
      setMsg({ kind: 'err', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const submitBankStatementLine = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bankData.activeBankId) return;
    setBusy(true);
    try {
      await apiRequest(`/companies/${company.id}/bank-reconciliation/lines`, {
        method: 'POST',
        body: {
          bankAccountId: bankData.activeBankId,
          statementDate: stmtForm.date,
          description: stmtForm.desc,
          reference: stmtForm.ref,
          amount: Number(stmtForm.amount),
        },
      });
      setStmtForm({ date: new Date().toISOString().slice(0, 10), desc: '', ref: '', amount: '' });
      await loadBankRec(bankData.activeBankId);
    } catch (err: any) {
      setMsg({ kind: 'err', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const toggleReconcile = async (lineId: number) => {
    await apiRequest(`/companies/${company.id}/bank-reconciliation/${lineId}/toggle`, { method: 'POST' });
    await loadBankRec(bankData.activeBankId || undefined);
  };

  const submitBudget = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await apiRequest(`/companies/${company.id}/budgets`, {
        method: 'POST',
        body: {
          accountId: Number(budgetForm.accountId),
          branchId: budgetForm.branchId ? Number(budgetForm.branchId) : null,
          fiscalYearLabel: company.fiscalYearLabel,
          budgetAmount: Number(budgetForm.amount),
        },
      });
      setBudgetForm({ ...budgetForm, amount: '' });
      await loadBudgets();
      setMsg({ kind: 'ok', text: 'Budget saved and Variance recalculated.' });
    } catch (err: any) {
      setMsg({ kind: 'err', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const submitAllocation = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const res = await apiRequest<{ entryNumber: string }>(`/companies/${company.id}/allocate-expense`, {
        method: 'POST',
        body: {
          entryDate: allocForm.date,
          expenseAccountId: allocForm.expenseAccountId,
          paidFromAccountId: allocForm.paidFromAccountId,
          sourceBranchId: branches[0]?.id,
          totalAmount: Number(allocForm.totalAmount),
          description: allocForm.description,
          splits: allocForm.splits,
        },
      });
      setMsg({ kind: 'ok', text: `Inter-branch expense allocation posted as ${res.entryNumber}.` });
      await onRefresh();
    } catch (err: any) {
      setMsg({ kind: 'err', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const tabs: Array<[AcctTab, string]> = [
    ['journals', 'Journal Vouchers & Approvals'],
    ['coa', 'Chart of Accounts'],
    ['gl', 'General Ledger'],
    ['bank', 'Bank Reconciliation'],
    ['budgets', 'Budgets vs Actual'],
    ['allocate', 'Inter-Branch Allocation'],
    ['locks', 'Period Locks'],
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 pb-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Enterprise Accounting &amp; General Ledger</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Double-entry enforcement · Maker-checker approval above {formatMoney(500000, company.currency)} · {centers.length} Cost/Profit Centers
          </p>
        </div>
      </div>

      {/* Sub-navigation tabs */}
      <div className="flex items-center gap-1 overflow-x-auto p-1 bg-slate-100 rounded-lg">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              setMsg(null);
              setSubTab(key);
            }}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              subTab === key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {msg && (
        <div
          className={`p-3 rounded-lg border text-sm ${
            msg.kind === 'ok'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-red-50 border-red-200 text-red-900'
          }`}
        >
          {msg.text}
        </div>
      )}

      {/* JOURNAL VOUCHERS & MANUAL DOUBLE-ENTRY */}
      {subTab === 'journals' && (
        <div className="space-y-6">
          <form onSubmit={submitJournal} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-3">
              <h2 className="text-sm font-semibold text-slate-900">Post Manual Double-Entry Journal Voucher</h2>
              <label className="inline-flex items-center gap-2 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={isElimination}
                  onChange={(e) => setIsElimination(e.target.checked)}
                />
                Mark as Group Consolidation Elimination Entry
              </label>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Posting Date</label>
                <input
                  type="date"
                  value={jeDate}
                  onChange={(e) => setJeDate(e.target.value)}
                  className="num w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                  required
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">Narration / Description</label>
                <input
                  type="text"
                  value={jeDesc}
                  onChange={(e) => setJeDesc(e.target.value)}
                  placeholder="Accrual, depreciation, adjustment, or inter-company elimination..."
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                  required
                />
              </div>
            </div>

            <div className="overflow-x-auto border border-slate-200 rounded-md">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-left text-xs text-slate-500">
                    <th className="px-3 py-2">Account</th>
                    <th className="px-3 py-2">Branch</th>
                    <th className="px-3 py-2 text-right">Debit</th>
                    <th className="px-3 py-2 text-right">Credit</th>
                    <th className="px-3 py-2">Line Memo</th>
                    <th className="px-2 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {jeLines.map((line, idx) => (
                    <tr key={idx}>
                      <td className="px-3 py-2">
                        <select
                          value={line.accountId}
                          onChange={(e) => {
                            const next = [...jeLines];
                            next[idx].accountId = Number(e.target.value);
                            setJeLines(next);
                          }}
                          className="w-full px-2 py-1.5 text-xs border border-slate-300 rounded bg-white"
                        >
                          {accounts.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.code} · {a.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <select
                          value={line.branchId}
                          onChange={(e) => {
                            const next = [...jeLines];
                            next[idx].branchId = Number(e.target.value);
                            setJeLines(next);
                          }}
                          className="w-full px-2 py-1.5 text-xs border border-slate-300 rounded bg-white"
                        >
                          {branches.map((b) => (
                            <option key={b.id} value={b.id}>
                              {b.code} · {b.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min="0"
                          step="any"
                          value={line.debit || ''}
                          onChange={(e) => {
                            const next = [...jeLines];
                            next[idx].debit = Number(e.target.value) || 0;
                            if (next[idx].debit > 0) next[idx].credit = 0;
                            setJeLines(next);
                          }}
                          className="num w-28 text-right px-2 py-1.5 text-xs border border-slate-300 rounded"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min="0"
                          step="any"
                          value={line.credit || ''}
                          onChange={(e) => {
                            const next = [...jeLines];
                            next[idx].credit = Number(e.target.value) || 0;
                            if (next[idx].credit > 0) next[idx].debit = 0;
                            setJeLines(next);
                          }}
                          className="num w-28 text-right px-2 py-1.5 text-xs border border-slate-300 rounded"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="text"
                          value={line.memo}
                          onChange={(e) => {
                            const next = [...jeLines];
                            next[idx].memo = e.target.value;
                            setJeLines(next);
                          }}
                          className="w-full px-2 py-1.5 text-xs border border-slate-300 rounded"
                        />
                      </td>
                      <td className="px-2 py-2">
                        {jeLines.length > 2 && (
                          <button
                            type="button"
                            onClick={() => setJeLines(jeLines.filter((_, i) => i !== idx))}
                            className="text-slate-400 hover:text-red-600"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <button
                type="button"
                onClick={() =>
                  setJeLines([
                    ...jeLines,
                    { accountId: accounts[0]?.id || 0, branchId: branches[0]?.id || 0, debit: 0, credit: 0, memo: '' },
                  ])
                }
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-md hover:bg-slate-50"
              >
                <Plus className="w-3.5 h-3.5" /> Add Line
              </button>

              <div className="flex items-center gap-5 text-xs">
                <span>
                  Debit: <strong className="num text-slate-900">{formatMoney(sumDr, company.currency)}</strong>
                </span>
                <span>
                  Credit: <strong className="num text-slate-900">{formatMoney(sumCr, company.currency)}</strong>
                </span>
                <span className={isJeBalanced ? 'font-semibold text-emerald-700' : 'font-semibold text-amber-700'}>
                  {isJeBalanced ? 'Balanced' : `Diff: ${formatMoney(Math.abs(sumDr - sumCr), company.currency)}`}
                </span>
                <button
                  type="submit"
                  disabled={busy || !isJeBalanced}
                  className="px-4 py-2 text-xs font-medium text-white bg-blue-700 rounded-md hover:bg-blue-800 disabled:opacity-50 whitespace-nowrap"
                >
                  {busy ? 'Posting...' : 'Post Journal Voucher'}
                </button>
              </div>
            </div>
          </form>

          {/* Journal Register Table */}
          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">Journal Voucher Register ({journals.length})</h3>
              <span className="text-xs text-slate-500">Active Approver Role: {user.role}</span>
            </div>
            <div className="divide-y divide-slate-200">
              {journals.map((je) => (
                <div key={je.id} className="p-4 hover:bg-slate-50/70">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <span className="num text-xs font-semibold text-slate-900">{je.entryNumber}</span>
                      <span className="mx-2 text-slate-300">·</span>
                      <span className="num text-xs text-slate-600">{je.entryDate}</span>
                      <span className="mx-2 text-slate-300">·</span>
                      <span className="text-sm font-medium text-slate-900">{je.description}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span
                        className={`text-xs font-semibold ${
                          je.status === 'POSTED'
                            ? 'text-emerald-700'
                            : je.status === 'PENDING_APPROVAL'
                              ? 'text-amber-700'
                              : 'text-red-700'
                        }`}
                      >
                        {je.status}
                        {je.isElimination ? ' · ELIMINATION' : ''}
                      </span>
                      <span className="num text-sm font-semibold text-slate-900">
                        {formatMoney(je.totalAmount, company.currency)}
                      </span>
                      {je.status === 'PENDING_APPROVAL' && (
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => handleDecision(je.id, 'APPROVE')}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-white bg-emerald-700 rounded hover:bg-emerald-800"
                          >
                            <Check className="w-3.5 h-3.5" /> Approve
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => handleDecision(je.id, 'REJECT')}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-red-700 border border-red-200 rounded hover:bg-red-50"
                          >
                            Reject
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="mt-2.5 overflow-x-auto">
                    <table className="w-full text-xs">
                      <tbody className="divide-y divide-slate-100">
                        {je.lines?.map((l) => (
                          <tr key={l.id}>
                            <td className="py-1 pr-3 num text-slate-500 w-16">{l.accountCode}</td>
                            <td className="py-1 pr-3 font-medium text-slate-800">{l.accountName}</td>
                            <td className="py-1 pr-3 text-slate-500">{l.branchName}</td>
                            <td className="py-1 pr-3 text-slate-500">{l.memo}</td>
                            <td className="py-1 px-2 num text-right text-slate-900 w-32">
                              {l.debit > 0 ? formatMoney(l.debit, company.currency) : '—'}
                            </td>
                            <td className="py-1 pl-2 num text-right text-slate-900 w-32">
                              {l.credit > 0 ? formatMoney(l.credit, company.currency) : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* CHART OF ACCOUNTS */}
      {subTab === 'coa' && (
        <div className="space-y-5">
          <form onSubmit={submitNewAccount} className="bg-white border border-slate-200 rounded-lg p-4 grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Code</label>
              <input
                type="text"
                value={newAcct.code}
                onChange={(e) => setNewAcct({ ...newAcct, code: e.target.value })}
                placeholder="e.g. 6400"
                className="num w-full px-3 py-1.5 text-sm border border-slate-300 rounded-md"
                required
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1">Account Name</label>
              <input
                type="text"
                value={newAcct.name}
                onChange={(e) => setNewAcct({ ...newAcct, name: e.target.value })}
                placeholder="Digital Marketing & Events"
                className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-md"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Type</label>
              <select
                value={newAcct.accountType}
                onChange={(e) => setNewAcct({ ...newAcct, accountType: e.target.value })}
                className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-md bg-white"
              >
                <option value="ASSET">ASSET</option>
                <option value="LIABILITY">LIABILITY</option>
                <option value="EQUITY">EQUITY</option>
                <option value="REVENUE">REVENUE</option>
                <option value="EXPENSE">EXPENSE</option>
              </select>
            </div>
            <button
              type="submit"
              disabled={busy}
              className="px-4 py-2 text-xs font-medium text-white bg-blue-700 rounded-md hover:bg-blue-800 whitespace-nowrap"
            >
              Add Account
            </button>
          </form>

          <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-left text-xs font-medium text-slate-500">
                  <th className="px-4 py-2.5">Code</th>
                  <th className="px-4 py-2.5">Account Name</th>
                  <th className="px-4 py-2.5">Class · Subtype</th>
                  <th className="px-4 py-2.5 text-right">Current Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {accounts.map((a) => (
                  <tr key={a.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2.5 num font-medium text-slate-900">{a.code}</td>
                    <td className="px-4 py-2.5 font-medium text-slate-800">
                      {a.name}
                      {a.isIntercompany === 1 && <span className="ml-2 text-xs text-blue-700">· Inter-Company</span>}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-slate-500">
                      {a.accountType} · {a.subType}
                    </td>
                    <td className="px-4 py-2.5 num text-right font-medium text-slate-900">
                      {formatMoney(a.balance, company.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* GENERAL LEDGER */}
      {subTab === 'gl' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-slate-900">General Ledger Detail</h2>
            <select
              value={glAccountId}
              onChange={(e) => {
                setGlAccountId(e.target.value);
                loadGl(e.target.value);
              }}
              className="px-3 py-1.5 text-xs border border-slate-300 rounded-md bg-white"
            >
              <option value="">All Accounts</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} · {a.name}
                </option>
              ))}
            </select>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-500">
                  <th className="px-3 py-2.5">Date</th>
                  <th className="px-3 py-2.5">Voucher</th>
                  <th className="px-3 py-2.5">Account</th>
                  <th className="px-3 py-2.5">Branch</th>
                  <th className="px-3 py-2.5">Narration</th>
                  <th className="px-3 py-2.5 text-right">Debit</th>
                  <th className="px-3 py-2.5 text-right">Credit</th>
                  <th className="px-3 py-2.5 text-right">Running</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {glRows.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50">
                    <td className="px-3 py-2 num text-slate-600">{r.entryDate}</td>
                    <td className="px-3 py-2 num font-medium text-slate-900">{r.entryNumber}</td>
                    <td className="px-3 py-2">
                      <span className="num text-slate-500">{r.accountCode}</span> {r.accountName}
                    </td>
                    <td className="px-3 py-2 text-slate-600">{r.branchName}</td>
                    <td className="px-3 py-2 text-slate-700">{r.memo || r.description}</td>
                    <td className="px-3 py-2 num text-right">{r.debit > 0 ? formatMoney(r.debit, company.currency) : '—'}</td>
                    <td className="px-3 py-2 num text-right">{r.credit > 0 ? formatMoney(r.credit, company.currency) : '—'}</td>
                    <td className="px-3 py-2 num text-right font-medium text-slate-900">
                      {formatMoney(r.runningBalance, company.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* BANK RECONCILIATION */}
      {subTab === 'bank' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {bankData.bankAccounts.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => loadBankRec(b.id)}
                className={`p-4 text-left rounded-lg border transition-colors ${
                  bankData.activeBankId === b.id
                    ? 'bg-blue-50/60 border-blue-600'
                    : 'bg-white border-slate-200 hover:bg-slate-50'
                }`}
              >
                <div className="text-xs text-slate-500">
                  <span className="num">{b.code}</span> · GL Book Balance
                </div>
                <div className="text-sm font-semibold text-slate-900 mt-0.5">{b.name}</div>
                <div className="num text-lg font-semibold text-slate-900 mt-2">
                  {formatMoney(b.bookBalance, company.currency)}
                </div>
              </button>
            ))}
          </div>

          <form onSubmit={submitBankStatementLine} className="bg-white border border-slate-200 rounded-lg p-4 grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Statement Date</label>
              <input
                type="date"
                value={stmtForm.date}
                onChange={(e) => setStmtForm({ ...stmtForm, date: e.target.value })}
                className="num w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded"
                required
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1">Bank Description</label>
              <input
                type="text"
                value={stmtForm.desc}
                onChange={(e) => setStmtForm({ ...stmtForm, desc: e.target.value })}
                placeholder="RTGS / Cheque / Bank Fee"
                className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Amount (+/-)</label>
              <input
                type="number"
                step="any"
                value={stmtForm.amount}
                onChange={(e) => setStmtForm({ ...stmtForm, amount: e.target.value })}
                className="num w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded"
                required
              />
            </div>
            <button type="submit" disabled={busy} className="px-3 py-2 text-xs font-medium text-white bg-blue-700 rounded hover:bg-blue-800">
              Import Statement Line
            </button>
          </form>

          <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-left text-xs text-slate-500">
                  <th className="px-4 py-2.5">Date</th>
                  <th className="px-4 py-2.5">Bank Statement Description</th>
                  <th className="px-4 py-2.5">Reference</th>
                  <th className="px-4 py-2.5 text-right">Amount</th>
                  <th className="px-4 py-2.5 text-right">Reconciliation</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {bankData.statements.map((st) => (
                  <tr key={st.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2.5 num text-slate-600">{st.statementDate}</td>
                    <td className="px-4 py-2.5 font-medium text-slate-900">{st.description}</td>
                    <td className="px-4 py-2.5 num text-xs text-slate-500">{st.reference || '—'}</td>
                    <td
                      className={`px-4 py-2.5 num text-right font-medium ${
                        st.amount >= 0 ? 'text-emerald-700' : 'text-red-700'
                      }`}
                    >
                      {formatMoney(st.amount, company.currency)}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <button
                        type="button"
                        onClick={() => toggleReconcile(st.id)}
                        className={`px-2.5 py-1 text-xs font-medium rounded border ${
                          st.isReconciled
                            ? 'text-emerald-800 bg-emerald-50 border-emerald-200'
                            : 'text-slate-700 bg-white border-slate-300 hover:bg-slate-50'
                        }`}
                      >
                        {st.isReconciled ? 'Reconciled' : 'Match & Reconcile'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* BUDGETS VS ACTUAL */}
      {subTab === 'budgets' && (
        <div className="space-y-4">
          <form onSubmit={submitBudget} className="bg-white border border-slate-200 rounded-lg p-4 grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">GL Account</label>
              <select
                value={budgetForm.accountId}
                onChange={(e) => setBudgetForm({ ...budgetForm, accountId: Number(e.target.value) })}
                className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded bg-white"
              >
                {accounts.filter((a) => a.accountType === 'REVENUE' || a.accountType === 'EXPENSE').map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} · {a.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Branch Scope</label>
              <select
                value={budgetForm.branchId}
                onChange={(e) => setBudgetForm({ ...budgetForm, branchId: e.target.value })}
                className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded bg-white"
              >
                <option value="">All Branches</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Annual Budget ({company.currency})</label>
              <input
                type="number"
                min="1"
                value={budgetForm.amount}
                onChange={(e) => setBudgetForm({ ...budgetForm, amount: e.target.value })}
                className="num w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded"
                required
              />
            </div>
            <button type="submit" disabled={busy} className="px-3 py-2 text-xs font-medium text-white bg-blue-700 rounded hover:bg-blue-800">
              Set / Update Budget
            </button>
          </form>

          <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-left text-xs text-slate-500">
                  <th className="px-4 py-2.5">Account</th>
                  <th className="px-4 py-2.5">Branch · Fiscal Year</th>
                  <th className="px-4 py-2.5 text-right">Budget</th>
                  <th className="px-4 py-2.5 text-right">Actual</th>
                  <th className="px-4 py-2.5 text-right">Variance</th>
                  <th className="px-4 py-2.5 text-right">Utilization</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {budgets.map((b) => (
                  <tr key={b.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2.5 font-medium text-slate-900">
                      <span className="num text-slate-500 mr-1.5">{b.accountCode}</span>
                      {b.accountName}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-slate-500">
                      {b.branchName || 'Company-Wide'} · {b.fiscalYearLabel}
                    </td>
                    <td className="px-4 py-2.5 num text-right">{formatMoney(b.budgetAmount, company.currency)}</td>
                    <td className="px-4 py-2.5 num text-right font-medium text-slate-900">
                      {formatMoney(b.actualAmount, company.currency)}
                    </td>
                    <td className="px-4 py-2.5 num text-right text-slate-700">
                      {formatMoney(b.variance, company.currency)}
                    </td>
                    <td className="px-4 py-2.5 num text-right font-semibold text-blue-700">{b.utilizationPct}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* INTER-BRANCH EXPENSE ALLOCATION */}
      {subTab === 'allocate' && (
        <form onSubmit={submitAllocation} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Inter-Branch Shared Expense Allocation</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Allocate a centralized Head Office bill across branches by percentage split. Posts a single balanced multi-branch journal voucher.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Date</label>
              <input
                type="date"
                value={allocForm.date}
                onChange={(e) => setAllocForm({ ...allocForm, date: e.target.value })}
                className="num w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Expense Account</label>
              <select
                value={allocForm.expenseAccountId}
                onChange={(e) => setAllocForm({ ...allocForm, expenseAccountId: Number(e.target.value) })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
              >
                {accounts.filter((a) => a.accountType === 'EXPENSE').map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} · {a.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Paid From Account</label>
              <select
                value={allocForm.paidFromAccountId}
                onChange={(e) => setAllocForm({ ...allocForm, paidFromAccountId: Number(e.target.value) })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
              >
                {accounts.filter((a) => a.isBankOrCash === 1).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} · {a.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Total Expense ({company.currency})</label>
              <input
                type="number"
                min="1"
                value={allocForm.totalAmount}
                onChange={(e) => setAllocForm({ ...allocForm, totalAmount: e.target.value })}
                className="num w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-xs font-medium text-slate-700">Branch Percentage Splits (Must equal 100%)</div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {allocForm.splits.map((sp, idx) => {
                const br = branches.find((b) => b.id === sp.branchId);
                return (
                  <div key={sp.branchId} className="p-3 border border-slate-200 rounded-md flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-slate-800">{br?.name}</span>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        min="0"
                        max="100"
                        value={sp.percent}
                        onChange={(e) => {
                          const next = [...allocForm.splits];
                          next[idx].percent = Number(e.target.value) || 0;
                          setAllocForm({ ...allocForm, splits: next });
                        }}
                        className="num w-16 text-right px-2 py-1 text-xs border border-slate-300 rounded"
                      />
                      <span className="text-xs text-slate-500">%</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex justify-end">
            <button type="submit" disabled={busy || branches.length < 2} className="px-4 py-2 text-xs font-medium text-white bg-blue-700 rounded-md hover:bg-blue-800 disabled:opacity-50">
              Post Branch Allocation Journal
            </button>
          </div>
        </form>
      )}

      {/* FINANCIAL PERIOD LOCKS */}
      {subTab === 'locks' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200">
            <h2 className="text-sm font-semibold text-slate-900">Financial Period Locking</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Locked periods block any invoice, payment, or journal posting dated inside the locked range (HTTP 423).
            </p>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-left text-xs text-slate-500">
                <th className="px-4 py-2.5">Period Name</th>
                <th className="px-4 py-2.5">Date Range</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Locked By</th>
                <th className="px-4 py-2.5 text-right">Control</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {locks.map((l) => (
                <tr key={l.id}>
                  <td className="px-4 py-3 font-medium text-slate-900">{l.periodName}</td>
                  <td className="px-4 py-3 num text-xs text-slate-600">
                    {l.startDate} to {l.endDate}
                  </td>
                  <td className="px-4 py-3 text-xs font-semibold">
                    {l.isLocked ? (
                      <span className="text-red-700">Locked</span>
                    ) : (
                      <span className="text-emerald-700">Open for Posting</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">{l.lockedByName || '—'}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => togglePeriodLock(l.id)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-slate-300 rounded-md hover:bg-slate-50"
                    >
                      {l.isLocked ? <Unlock className="w-3.5 h-3.5" /> : <Lock className="w-3.5 h-3.5" />}
                      {l.isLocked ? 'Unlock Period' : 'Lock Period'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
