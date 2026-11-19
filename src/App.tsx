import React, { useCallback, useEffect, useState } from 'react';
import {
  BarChart3,
  BookOpen,
  Building2,
  LayoutDashboard,
  Layers,
  Menu,
  Package,
  Receipt,
  ShieldCheck,
  X,
} from 'lucide-react';
import { apiRequest, setAuthToken } from './lib/api.ts';
import type {
  Account,
  AuthUser,
  Branch,
  Company,
  CostProfitCenter,
  ErpUiMode,
  InventoryItem,
  InvoiceRecord,
  JournalEntry,
  Party,
  Warehouse,
} from './shared/types.ts';
import { SimpleModeWorkspace } from './components/SimpleModeWorkspace.tsx';
import { DashboardModule } from './components/DashboardModule.tsx';
import { AccountingModule } from './components/AccountingModule.tsx';
import { CommercialModule } from './components/CommercialModule.tsx';
import { InventoryModule } from './components/InventoryModule.tsx';
import { ReportsModule } from './components/ReportsModule.tsx';
import { GovernanceModule } from './components/GovernanceModule.tsx';

type NavSection = 'dashboard' | 'accounting' | 'commercial' | 'inventory' | 'reports' | 'governance';

const SECTION_LABELS: Record<NavSection, string> = {
  dashboard: 'Executive Overview',
  accounting: 'Accounting & General Ledger',
  commercial: 'Sales, Purchases & Parties',
  inventory: 'Inventory & Warehouses',
  reports: 'Financial Reports & Consolidation',
  governance: 'Security, Entities & Verification',
};

export default function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [mode, setMode] = useState<ErpUiMode>('advanced');
  const [section, setSection] = useState<NavSection>('dashboard');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<number | null>(null);
  const [selectedBranchId, setSelectedBranchId] = useState<number | null>(null);

  const [branches, setBranches] = useState<Branch[]>([]);
  const [centers, setCenters] = useState<CostProfitCenter[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [parties, setParties] = useState<Party[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRecord[]>([]);
  const [journals, setJournals] = useState<JournalEntry[]>([]);
  const [financials, setFinancials] = useState<any>(null);
  const [analytics, setAnalytics] = useState<any>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadCompanyWorkspace = useCallback(
    async (companyId: number, branchFilter: number | null) => {
      const brQuery = branchFilter ? `?branchId=${branchFilter}` : '';
      const [brs, ctrs, accts, prts, whs, itms, invs, jnls, fins, anl] = await Promise.all([
        apiRequest<Branch[]>(`/companies/${companyId}/branches`),
        apiRequest<CostProfitCenter[]>(`/companies/${companyId}/centers`),
        apiRequest<Account[]>(`/companies/${companyId}/accounts`),
        apiRequest<Party[]>(`/companies/${companyId}/parties`),
        apiRequest<Warehouse[]>(`/companies/${companyId}/warehouses`),
        apiRequest<InventoryItem[]>(`/companies/${companyId}/items${brQuery}`),
        apiRequest<InvoiceRecord[]>(`/companies/${companyId}/invoices${brQuery}`),
        apiRequest<JournalEntry[]>(`/companies/${companyId}/journals?limit=60`),
        apiRequest<any>(`/companies/${companyId}/reports/financials${brQuery}`),
        apiRequest<any>(`/companies/${companyId}/reports/analytics`),
      ]);
      setBranches(brs);
      setCenters(ctrs);
      setAccounts(accts);
      setParties(prts);
      setWarehouses(whs);
      setItems(itms);
      setInvoices(invs);
      setJournals(jnls);
      setFinancials(fins);
      setAnalytics(anl);
    },
    []
  );

  const bootstrapSession = useCallback(
    async (personaEmail = 'admin@nextgenerp.com') => {
      setLoading(true);
      setError(null);
      try {
        const authRes = await apiRequest<{ token: string; user: AuthUser }>('/auth/switch-persona', {
          method: 'POST',
          body: { email: personaEmail },
        });
        setAuthToken(authRes.token);
        setUser(authRes.user);
        setMode(authRes.user.defaultMode);

        const comps = await apiRequest<Company[]>('/companies');
        setCompanies(comps);
        const firstId = comps[0]?.id ?? null;
        setSelectedCompanyId(firstId);
        setSelectedBranchId(null);

        if (firstId) {
          await loadCompanyWorkspace(firstId, null);
        }
      } catch (err: any) {
        setError(err?.message || 'Unable to connect to NEXTGEN ERP backend.');
      } finally {
        setLoading(false);
      }
    },
    [loadCompanyWorkspace]
  );

  useEffect(() => {
    bootstrapSession();
  }, [bootstrapSession]);

  const handleCompanyChange = async (nextCompanyId: number) => {
    setSelectedCompanyId(nextCompanyId);
    setSelectedBranchId(null);
    setLoading(true);
    try {
      await loadCompanyWorkspace(nextCompanyId, null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleBranchChange = async (nextBranchId: number | null) => {
    if (!selectedCompanyId) return;
    setSelectedBranchId(nextBranchId);
    await loadCompanyWorkspace(selectedCompanyId, nextBranchId);
  };

  const handleRefresh = async () => {
    const comps = await apiRequest<Company[]>('/companies');
    setCompanies(comps);
    if (selectedCompanyId) {
      await loadCompanyWorkspace(selectedCompanyId, selectedBranchId);
    }
  };

  const activeCompany = companies.find((c) => c.id === selectedCompanyId) || companies[0];

  if (loading && !activeCompany) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="bg-white border border-slate-200 rounded-lg p-6 max-w-md w-full space-y-2">
          <div className="text-lg font-bold text-slate-900">NEXTGEN ERP</div>
          <p className="text-sm text-slate-500">Initializing multi-company accounting &amp; inventory workspace...</p>
        </div>
      </div>
    );
  }

  if (error || !activeCompany || !user) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="bg-white border border-red-200 rounded-lg p-6 max-w-md w-full space-y-3">
          <h1 className="text-base font-semibold text-red-800">Workspace Initialization Error</h1>
          <p className="text-sm text-slate-600">{error || 'No authorized companies found.'}</p>
          <button
            type="button"
            onClick={() => bootstrapSession()}
            className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800"
          >
            Retry Connection
          </button>
        </div>
      </div>
    );
  }

  // SIMPLE MODE LAYOUT (Karobar-inspired)
  if (mode === 'simple') {
    return (
      <div className="min-h-screen bg-slate-50">
        <header className="sticky top-0 z-30 bg-white border-b border-slate-200 px-4 sm:px-6 h-14 flex items-center justify-between gap-6">
          <div className="text-base font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0">
            NEXTGEN ERP
          </div>

          <div className="flex items-center gap-3 overflow-x-auto">
            <select
              aria-label="Active Company"
              value={activeCompany.id}
              onChange={(e) => handleCompanyChange(Number(e.target.value))}
              className="px-2.5 py-1.5 text-xs font-medium border border-slate-300 rounded-md bg-white text-slate-800"
            >
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} · {c.legalName}
                </option>
              ))}
            </select>
            <span className="hidden md:inline text-xs text-slate-500 whitespace-nowrap">
              {user.fullName} · {user.role}
            </span>
          </div>

          <button
            type="button"
            onClick={() => setMode('advanced')}
            className="px-3.5 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 whitespace-nowrap shrink-0"
          >
            Advanced Mode
          </button>
        </header>

        <SimpleModeWorkspace
          company={activeCompany}
          branches={branches}
          selectedBranchId={selectedBranchId}
          accounts={accounts}
          parties={parties}
          items={items}
          warehouses={warehouses}
          invoices={invoices}
          onRefresh={handleRefresh}
          onSwitchToAdvanced={() => setMode('advanced')}
        />
      </div>
    );
  }

  // ADVANCED ENTERPRISE MODE LAYOUT
  const navItems: Array<{ id: NavSection; label: string; icon: React.ReactNode }> = [
    { id: 'dashboard', label: 'Executive Overview', icon: <LayoutDashboard className="w-4 h-4 shrink-0" /> },
    { id: 'accounting', label: 'Accounting & GL', icon: <BookOpen className="w-4 h-4 shrink-0" /> },
    { id: 'commercial', label: 'Sales & Purchases', icon: <Receipt className="w-4 h-4 shrink-0" /> },
    { id: 'inventory', label: 'Inventory & Lots', icon: <Package className="w-4 h-4 shrink-0" /> },
    { id: 'reports', label: 'Reports & Group', icon: <BarChart3 className="w-4 h-4 shrink-0" /> },
    { id: 'governance', label: 'Governance & Tests', icon: <ShieldCheck className="w-4 h-4 shrink-0" /> },
  ];

  const SidebarContent = (
    <div className="flex flex-col h-full bg-slate-900 text-slate-100">
      <div className="h-14 px-5 flex items-center justify-between border-b border-slate-800">
        <span className="text-base font-bold tracking-tight text-white whitespace-nowrap">NEXTGEN ERP</span>
        <button
          type="button"
          onClick={() => setMobileMenuOpen(false)}
          className="lg:hidden text-slate-400 hover:text-white"
          aria-label="Close Navigation"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Company & Branch Tenant Context Switchers */}
      <div className="p-4 space-y-3 border-b border-slate-800">
        <div>
          <label className="block text-[11px] font-medium text-slate-400 mb-1">Legal Entity (Company)</label>
          <select
            value={activeCompany.id}
            onChange={(e) => handleCompanyChange(Number(e.target.value))}
            className="w-full px-2.5 py-1.5 text-xs font-medium bg-slate-800 border border-slate-700 text-white rounded-md"
          >
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} · {c.legalName}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-[11px] font-medium text-slate-400 mb-1">Branch Scope</label>
          <select
            value={selectedBranchId ?? ''}
            onChange={(e) => handleBranchChange(e.target.value ? Number(e.target.value) : null)}
            className="w-full px-2.5 py-1.5 text-xs bg-slate-800 border border-slate-700 text-slate-200 rounded-md"
          >
            <option value="">All Authorized Branches ({branches.length})</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code} · {b.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Primary Module Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {navItems.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => {
              setSection(item.id);
              setMobileMenuOpen(false);
            }}
            className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              section === item.id
                ? 'bg-blue-700 text-white'
                : 'text-slate-300 hover:bg-slate-800 hover:text-white'
            }`}
          >
            {item.icon}
            <span className="truncate">{item.label}</span>
          </button>
        ))}
      </nav>

      {/* Experience Switcher & Active Session Footer */}
      <div className="p-4 border-t border-slate-800 space-y-3">
        <div className="grid grid-cols-2 gap-1 p-1 bg-slate-800 rounded-md">
          <button
            type="button"
            onClick={() => setMode('simple')}
            className="py-1.5 text-xs font-medium rounded text-slate-300 hover:text-white whitespace-nowrap"
          >
            Simple Mode
          </button>
          <button
            type="button"
            onClick={() => setMode('advanced')}
            className="py-1.5 text-xs font-medium rounded bg-slate-700 text-white whitespace-nowrap"
          >
            Advanced
          </button>
        </div>

        <div className="text-xs text-slate-300">
          <div className="font-medium text-white truncate">{user.fullName}</div>
          <div className="text-[11px] text-slate-400 truncate">
            {user.role} · {activeCompany.fiscalYearLabel}
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:block w-64 shrink-0 sticky top-0 h-screen">{SidebarContent}</aside>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div className="w-64 h-full">{SidebarContent}</div>
          <div className="flex-1 bg-slate-900/50" onClick={() => setMobileMenuOpen(false)} />
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Clean Contextual Top Bar */}
        <header className="sticky top-0 z-20 h-14 bg-white border-b border-slate-200 px-4 sm:px-6 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-1.5 text-slate-600 hover:text-slate-900"
              aria-label="Open Navigation"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-xs text-slate-500 truncate">
              <Building2 className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <span className="font-medium text-slate-900 truncate">{activeCompany.code}</span>
              <span>/</span>
              <span className="truncate">{SECTION_LABELS[section]}</span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setMode('simple')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 whitespace-nowrap shrink-0"
          >
            <Layers className="w-3.5 h-3.5" /> Switch to Simple Mode
          </button>
        </header>

        <main className="flex-1 p-4 sm:p-6 max-w-[1360px] w-full mx-auto">
          {section === 'dashboard' && (
            <DashboardModule
              company={activeCompany}
              financials={financials}
              analytics={analytics}
              journals={journals}
              items={items}
              onNavigate={(sec) => setSection(sec as NavSection)}
            />
          )}

          {section === 'accounting' && (
            <AccountingModule
              company={activeCompany}
              user={user}
              branches={branches}
              centers={centers}
              accounts={accounts}
              journals={journals}
              onRefresh={handleRefresh}
            />
          )}

          {section === 'commercial' && (
            <CommercialModule
              company={activeCompany}
              branches={branches}
              accounts={accounts}
              parties={parties}
              items={items}
              warehouses={warehouses}
              invoices={invoices}
              onRefresh={handleRefresh}
            />
          )}

          {section === 'inventory' && (
            <InventoryModule
              company={activeCompany}
              items={items}
              warehouses={warehouses}
              onRefresh={handleRefresh}
            />
          )}

          {section === 'reports' && (
            <ReportsModule
              company={activeCompany}
              branches={branches}
              financials={financials}
              analytics={analytics}
              selectedBranchId={selectedBranchId}
            />
          )}

          {section === 'governance' && (
            <GovernanceModule
              company={activeCompany}
              companies={companies}
              branches={branches}
              user={user}
              onRefresh={handleRefresh}
              onSwitchPersona={bootstrapSession}
            />
          )}
        </main>
      </div>
    </div>
  );
}
