import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  DatabaseBackup,
  Download,
  Gauge,
  Play,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { apiRequest } from '../lib/api.ts';
import { downloadJson } from '../lib/format.ts';
import type {
  AuditLogRow,
  AuthUser,
  Branch,
  Company,
  ModuleChecklistItem,
  VerificationCheck,
} from '../shared/types.ts';

interface GovernanceProps {
  company: Company;
  companies: Company[];
  branches: Branch[];
  user: AuthUser;
  onRefresh: () => Promise<void>;
  onSwitchPersona: (email: string) => Promise<void>;
}

type GovTab = 'verification' | 'entities' | 'security' | 'audit' | 'backups';

export const GovernanceModule: React.FC<GovernanceProps> = ({
  company,
  companies,
  branches,
  user,
  onRefresh,
  onSwitchPersona,
}) => {
  const [tab, setTab] = useState<GovTab>('verification');
  const [checklist, setChecklist] = useState<ModuleChecklistItem[]>([]);
  const [testReport, setTestReport] = useState<{
    passedCount: number;
    totalCount: number;
    checks: VerificationCheck[];
    executedAt: string;
  } | null>(null);
  const [benchResult, setBenchResult] = useState<any>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLogRow[]>([]);
  const [usersList, setUsersList] = useState<any[]>([]);
  const [backups, setBackups] = useState<Array<{ fileName: string; sizeBytes: number; createdAt: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const [newCo, setNewCo] = useState({
    code: '',
    legalName: '',
    panVatNumber: '',
    vatRate: '13',
    currency: 'NPR',
    headOfficeCity: 'Kathmandu',
  });

  const [newBr, setNewBr] = useState({
    code: '',
    name: '',
    branchType: 'SALES_BRANCH',
    city: '',
  });

  const loadChecklist = async () => {
    const rows = await apiRequest<ModuleChecklistItem[]>('/verification/checklist');
    setChecklist(rows);
  };

  const loadAudit = async () => {
    const rows = await apiRequest<AuditLogRow[]>(`/companies/${company.id}/audit-logs`);
    setAuditLogs(rows);
  };

  const loadUsers = async () => {
    const rows = await apiRequest<any[]>('/security/users');
    setUsersList(rows);
  };

  const loadBackups = async () => {
    const rows = await apiRequest<any[]>('/security/backups');
    setBackups(rows);
  };

  useEffect(() => {
    if (tab === 'verification') loadChecklist();
    if (tab === 'audit') loadAudit();
    if (tab === 'security') loadUsers();
    if (tab === 'backups') loadBackups();
  }, [tab, company.id]);

  const runVerification = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const report = await apiRequest<any>('/verification/run-tests', { method: 'POST' });
      setTestReport(report);
    } catch (err: any) {
      setMsg({ kind: 'err', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const runBenchmark = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await apiRequest<any>('/verification/load-test', {
        method: 'POST',
        body: { iterations: 80 },
      });
      setBenchResult(res);
    } catch (err: any) {
      setMsg({ kind: 'err', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const submitCompany = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const res = await apiRequest<{ code: string; legalName: string }>('/companies', {
        method: 'POST',
        body: newCo,
      });
      setMsg({
        kind: 'ok',
        text: `Provisioned legal entity ${res.code} (${res.legalName}) with independent COA, Head Office branch, and warehouse.`,
      });
      setNewCo({ code: '', legalName: '', panVatNumber: '', vatRate: '13', currency: 'NPR', headOfficeCity: 'Kathmandu' });
      await onRefresh();
    } catch (err: any) {
      setMsg({ kind: 'err', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const submitBranch = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await apiRequest(`/companies/${company.id}/branches`, { method: 'POST', body: newBr });
      setMsg({ kind: 'ok', text: `Added branch ${newBr.name} (${newBr.branchType}) and default warehouse.` });
      setNewBr({ code: '', name: '', branchType: 'SALES_BRANCH', city: '' });
      await onRefresh();
    } catch (err: any) {
      setMsg({ kind: 'err', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const triggerBackup = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const b = await apiRequest<{ fileName: string; sizeBytes: number }>('/security/backups', { method: 'POST' });
      setMsg({ kind: 'ok', text: `Snapshot created: ${b.fileName} (${(b.sizeBytes / 1024).toFixed(1)} KB).` });
      await loadBackups();
    } catch (err: any) {
      setMsg({ kind: 'err', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const exportCompanyArchive = async () => {
    const data = await apiRequest(`/companies/${company.id}/export`);
    downloadJson(`${company.code}_full_erp_archive.json`, data);
  };

  const tabs: Array<[GovTab, string]> = [
    ['verification', 'Verification, Tests & Checklist'],
    ['entities', 'Companies & Branches'],
    ['security', 'RBAC Users & Personas'],
    ['audit', 'Immutable Audit Trail'],
    ['backups', 'Backups & Export'],
  ];

  return (
    <div className="space-y-5">
      <div className="border-b border-slate-200 pb-4">
        <h1 className="text-xl font-bold text-slate-900">Architecture Governance, Security &amp; Verification</h1>
        <p className="text-xs text-slate-500 mt-0.5">
          Multi-company provisioning · Tenant RBAC · Immutable audit log · Live financial integrity &amp; load testing
        </p>
      </div>

      <div className="flex items-center gap-1 overflow-x-auto p-1 bg-slate-100 rounded-lg">
        {tabs.map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => {
              setTab(k);
              setMsg(null);
            }}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              tab === k ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
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

      {/* VERIFICATION, AUTOMATED TESTS, LOAD BENCHMARK & CHECKLIST */}
      {tab === 'verification' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold text-slate-900">Automated Financial &amp; Isolation Test Suite</h2>
                  <p className="text-xs text-slate-500">
                    Verifies Trial Balance, Balance Sheet equation, consolidated eliminations, tenant isolation, stock lots &amp; period locks.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={runVerification}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-blue-700 rounded-md hover:bg-blue-800 whitespace-nowrap shrink-0"
                >
                  <Play className="w-3.5 h-3.5" /> Run Integrity Suite
                </button>
              </div>

              {testReport && (
                <div className="space-y-2 pt-2 border-t border-slate-200">
                  <div className="text-xs font-semibold text-slate-900">
                    Result: {testReport.passedCount} / {testReport.totalCount} Checks Passed
                  </div>
                  <div className="divide-y divide-slate-100">
                    {testReport.checks.map((c) => (
                      <div key={c.id} className="py-2 flex items-start gap-2.5 text-xs">
                        {c.passed ? (
                          <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
                        ) : (
                          <XCircle className="w-4 h-4 text-red-700 shrink-0 mt-0.5" />
                        )}
                        <div className="flex-1">
                          <div className="font-medium text-slate-900">
                            {c.name} <span className="num text-slate-400 ml-1">({c.durationMs}ms)</span>
                          </div>
                          <div className="text-slate-600 mt-0.5">{c.details}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold text-slate-900">Measured Transaction Load Benchmark</h2>
                  <p className="text-xs text-slate-500">
                    Runs 80 live ACID SQLite WAL write+read transactions and reports observed throughput and latency.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={runBenchmark}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-900 bg-white border border-slate-300 rounded-md hover:bg-slate-50 whitespace-nowrap shrink-0"
                >
                  <Gauge className="w-3.5 h-3.5" /> Run Load Test
                </button>
              </div>

              {benchResult && (
                <div className="space-y-3 pt-2 border-t border-slate-200">
                  <div className="grid grid-cols-3 gap-3">
                    <div className="p-3 bg-slate-50 rounded border border-slate-200">
                      <div className="text-[11px] text-slate-500">Throughput</div>
                      <div className="num text-base font-bold text-slate-900">{benchResult.opsPerSec} tx/s</div>
                    </div>
                    <div className="p-3 bg-slate-50 rounded border border-slate-200">
                      <div className="text-[11px] text-slate-500">p50 Latency</div>
                      <div className="num text-base font-bold text-slate-900">{benchResult.p50LatencyMs} ms</div>
                    </div>
                    <div className="p-3 bg-slate-50 rounded border border-slate-200">
                      <div className="text-[11px] text-slate-500">p95 Latency</div>
                      <div className="num text-base font-bold text-slate-900">{benchResult.p95LatencyMs} ms</div>
                    </div>
                  </div>
                  <p className="text-xs text-slate-600">{benchResult.note}</p>
                </div>
              )}
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
            <div className="px-5 py-3 border-b border-slate-200 text-sm font-semibold text-slate-900">
              Enterprise Architecture Module Completion Checklist
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-left text-xs text-slate-500">
                  <th className="px-4 py-2.5">Architecture Pillar</th>
                  <th className="px-4 py-2.5">Scope &amp; Implementation Notes</th>
                  <th className="px-4 py-2.5 text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {checklist.map((item) => (
                  <tr key={item.module}>
                    <td className="px-4 py-3 font-medium text-slate-900 align-top whitespace-nowrap">{item.module}</td>
                    <td className="px-4 py-3">
                      <div className="text-slate-800 text-xs font-medium">{item.capability}</div>
                      <div className="text-slate-500 text-xs mt-0.5">{item.notes}</div>
                    </td>
                    <td className="px-4 py-3 text-right align-top">
                      <span
                        className={`text-xs font-semibold ${
                          item.status === 'IMPLEMENTED'
                            ? 'text-emerald-700'
                            : item.status === 'PARTIAL'
                              ? 'text-amber-700'
                              : 'text-slate-500'
                        }`}
                      >
                        {item.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* MULTI-COMPANY & MULTI-BRANCH PROVISIONING */}
      {tab === 'entities' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
            <h2 className="text-sm font-semibold text-slate-900">
              Provision New Independent Legal Entity ({companies.length} Active)
            </h2>
            <form onSubmit={submitCompany} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Company Code</label>
                  <input
                    type="text"
                    value={newCo.code}
                    onChange={(e) => setNewCo({ ...newCo, code: e.target.value })}
                    placeholder="e.g. KTL"
                    className="num w-full px-3 py-1.5 text-sm border border-slate-300 rounded"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">PAN / VAT Number</label>
                  <input
                    type="text"
                    value={newCo.panVatNumber}
                    onChange={(e) => setNewCo({ ...newCo, panVatNumber: e.target.value })}
                    placeholder="609112233"
                    className="num w-full px-3 py-1.5 text-sm border border-slate-300 rounded"
                    required
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Legal Name</label>
                <input
                  type="text"
                  value={newCo.legalName}
                  onChange={(e) => setNewCo({ ...newCo, legalName: e.target.value })}
                  placeholder="Kathmandu Logistics & Cargo Ltd."
                  className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded"
                  required
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Currency</label>
                  <input
                    type="text"
                    value={newCo.currency}
                    onChange={(e) => setNewCo({ ...newCo, currency: e.target.value })}
                    className="num w-full px-3 py-1.5 text-sm border border-slate-300 rounded"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">VAT Rate %</label>
                  <input
                    type="number"
                    value={newCo.vatRate}
                    onChange={(e) => setNewCo({ ...newCo, vatRate: e.target.value })}
                    className="num w-full px-3 py-1.5 text-sm border border-slate-300 rounded"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">HO City</label>
                  <input
                    type="text"
                    value={newCo.headOfficeCity}
                    onChange={(e) => setNewCo({ ...newCo, headOfficeCity: e.target.value })}
                    className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded"
                  />
                </div>
              </div>
              <button type="submit" disabled={busy} className="px-4 py-2 text-xs font-medium text-white bg-blue-700 rounded hover:bg-blue-800">
                Create Independent Company
              </button>
            </form>
          </div>

          <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
            <h2 className="text-sm font-semibold text-slate-900">
              Add Branch to {company.code} ({branches.length} Branches)
            </h2>
            <form onSubmit={submitBranch} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Branch Code</label>
                  <input
                    type="text"
                    value={newBr.code}
                    onChange={(e) => setNewBr({ ...newBr, code: e.target.value })}
                    placeholder="BRT-SB"
                    className="num w-full px-3 py-1.5 text-sm border border-slate-300 rounded"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Branch Type</label>
                  <select
                    value={newBr.branchType}
                    onChange={(e) => setNewBr({ ...newBr, branchType: e.target.value })}
                    className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded bg-white"
                  >
                    <option value="HEAD_OFFICE">Head Office</option>
                    <option value="REGIONAL_OFFICE">Regional Office</option>
                    <option value="SALES_BRANCH">Sales Branch</option>
                    <option value="SERVICE_BRANCH">Service Branch</option>
                    <option value="WAREHOUSE">Warehouse</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Branch Name</label>
                  <input
                    type="text"
                    value={newBr.name}
                    onChange={(e) => setNewBr({ ...newBr, name: e.target.value })}
                    placeholder="Biratnagar Regional Sales"
                    className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">City</label>
                  <input
                    type="text"
                    value={newBr.city}
                    onChange={(e) => setNewBr({ ...newBr, city: e.target.value })}
                    placeholder="Biratnagar"
                    className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded"
                  />
                </div>
              </div>
              <button type="submit" disabled={busy} className="px-4 py-2 text-xs font-medium text-white bg-blue-700 rounded hover:bg-blue-800">
                Add Branch &amp; Default Warehouse
              </button>
            </form>

            <div className="pt-3 border-t border-slate-200 divide-y divide-slate-100 text-xs">
              {branches.map((b) => (
                <div key={b.id} className="py-2 flex items-center justify-between">
                  <div>
                    <span className="num font-semibold text-slate-900">{b.code}</span> · {b.name}
                  </div>
                  <span className="text-slate-500">
                    {b.branchType} · {b.city}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* RBAC USERS & INSTANT PERSONA SWITCHER */}
      {tab === 'security' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
          <div className="px-5 py-3.5 border-b border-slate-200 flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-blue-700" />
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Role-Based Access Control (RBAC) &amp; Tenant Isolation</h2>
              <p className="text-xs text-slate-500">
                Switch active persona to verify strict company/branch isolation and Segregation of Duties on pending vouchers.
              </p>
            </div>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-left text-xs text-slate-500">
                <th className="px-4 py-2.5">User</th>
                <th className="px-4 py-2.5">Role · Default Mode</th>
                <th className="px-4 py-2.5">Authorized Entities / Branches</th>
                <th className="px-4 py-2.5 text-right">Session Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {usersList.map((u) => (
                <tr key={u.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900">{u.fullName}</div>
                    <div className="num text-xs text-slate-500">{u.email}</div>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-700">
                    <strong>{u.role}</strong> · {u.defaultMode} mode
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-600">
                    {u.role === 'SUPER_ADMIN'
                      ? 'All Companies & All Branches'
                      : u.permissions
                          .map((p: any) => `${p.companyCode} (${p.branchCode || 'All Branches'})`)
                          .join(' · ')}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {u.id === user.id ? (
                      <span className="text-xs font-semibold text-emerald-700">Active Session</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onSwitchPersona(u.email)}
                        className="px-3 py-1.5 text-xs font-medium text-blue-700 border border-blue-200 rounded hover:bg-blue-50 whitespace-nowrap"
                      >
                        Switch Role
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* IMMUTABLE AUDIT TRAIL */}
      {tab === 'audit' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-500">
                <th className="px-3 py-2.5">Timestamp</th>
                <th className="px-3 py-2.5">User · Role</th>
                <th className="px-3 py-2.5">Action</th>
                <th className="px-3 py-2.5">Entity</th>
                <th className="px-3 py-2.5">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {auditLogs.map((log) => (
                <tr key={log.id} className="hover:bg-slate-50">
                  <td className="px-3 py-2 num text-slate-500 whitespace-nowrap">{String(log.createdAt).slice(0, 19)}</td>
                  <td className="px-3 py-2 text-slate-800 whitespace-nowrap">
                    {log.userName} · <span className="text-slate-500">{log.userRole}</span>
                  </td>
                  <td className="px-3 py-2 num font-medium text-slate-900">{log.action}</td>
                  <td className="px-3 py-2 num text-slate-600">
                    {log.entityType}:{log.entityId}
                  </td>
                  <td className="px-3 py-2 text-slate-700">{log.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* BACKUPS & DATA EXPORT */}
      {tab === 'backups' && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-lg p-5 flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">ACID Database Snapshots &amp; Compliance Data Export</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Create consistent point-in-time SQLite WAL backups via VACUUM INTO or export the active company&apos;s complete ledger archive.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={triggerBackup}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-blue-700 rounded-md hover:bg-blue-800 whitespace-nowrap"
              >
                <DatabaseBackup className="w-3.5 h-3.5" /> Create Backup Snapshot
              </button>
              <button
                type="button"
                onClick={exportCompanyArchive}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5" /> Export {company.code} JSON
              </button>
              <a
                href="/api/migrations/0001.sql"
                download="0001.sql"
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-300 rounded-md hover:bg-emerald-100 whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5" /> Download 0001.sql
              </a>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-left text-xs text-slate-500">
                  <th className="px-4 py-2.5">Backup Snapshot File</th>
                  <th className="px-4 py-2.5">Created At</th>
                  <th className="px-4 py-2.5 text-right">Size</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {backups.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-4 py-6 text-center text-slate-500 text-xs">
                      No snapshots created yet. Click &quot;Create Backup Snapshot&quot; above to run an ACID backup.
                    </td>
                  </tr>
                ) : (
                  backups.map((b) => (
                    <tr key={b.fileName}>
                      <td className="px-4 py-2.5 num font-medium text-slate-900">{b.fileName}</td>
                      <td className="px-4 py-2.5 num text-xs text-slate-600">{b.createdAt.slice(0, 19)}</td>
                      <td className="px-4 py-2.5 num text-right text-slate-700">
                        {(b.sizeBytes / 1024).toFixed(1)} KB
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
