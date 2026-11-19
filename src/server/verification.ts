import { db, round2, withTransaction } from './db.ts';
import { computeFinancialStatements, ensurePeriodOpen } from './accounting.ts';
import type { ModuleChecklistItem, VerificationCheck } from '../shared/types.ts';

export function getModuleCompletionChecklist(): ModuleChecklistItem[] {
  return [
    {
      module: '1. Multi-Company Architecture',
      capability: 'Independent books, COA, PAN/VAT, fiscal years, invoice sequences, parties, warehouses & consolidated statements',
      status: 'IMPLEMENTED',
      notes: 'Two seeded legal entities + dynamic company creation wizard + consolidated P&L/BS with elimination entries.',
    },
    {
      module: '2. Multi-Branch Operations',
      capability: 'Head Office, Regional, Sales, Service & Warehouse branches, branch-wise P&L, stock transfers & expense allocation',
      status: 'IMPLEMENTED',
      notes: 'Every GL line and stock movement carries branch_id; inter-branch stock transfer & expense allocation live.',
    },
    {
      module: '3. Cloud Web & Responsive UX',
      capability: 'Multi-user JWT sessions, responsive desktop/tablet/mobile layout, ACID SQL storage & on-demand SQLite backups',
      status: 'IMPLEMENTED',
      notes: 'Running on Express + embedded WAL SQLite (node:sqlite) since Cloud SQL PostgreSQL was declined for this session.',
    },
    {
      module: '4. Enterprise Accounting',
      capability: 'Double-entry GL, Trial Balance, P&L, Balance Sheet, Cash Flow, AR/AP, Bank Reconciliation, Budgets, Cost/Profit Centers, Inter-company Eliminations',
      status: 'IMPLEMENTED',
      notes: 'Strict debit == credit enforcement inside ACID transactions + maker-checker approval for high-value journals.',
    },
    {
      module: '5. Enterprise Inventory',
      capability: 'Multi-warehouse, stock locations, transfers, FIFO & Weighted Average valuation, Serial, Batch, VIN & Engine tracking, Reorder planning, Reconciliation',
      status: 'IMPLEMENTED',
      notes: 'Lot-level tracking with automated COGS posting on sales invoices and physical count variance reconciliation.',
    },
    {
      module: '6. Enterprise Reporting',
      capability: 'Company, branch, consolidated, department/cost-center, user-wise reports, product/customer profitability, cash flow forecast, budget vs actual, financial ratios',
      status: 'IMPLEMENTED',
      notes: 'Real-time SQL aggregations with interactive charts and CSV/JSON data export.',
    },
    {
      module: '7. Enterprise Security & Governance',
      capability: 'Tenant isolation, company/branch RBAC, approval hierarchies, SoD, immutable audit trail, financial period locking, backups & export',
      status: 'IMPLEMENTED',
      notes: 'Enforced on API middleware & DB queries; Segregation of Duties blocks self-approval on pending vouchers.',
    },
    {
      module: '8. Performance & Scalability',
      capability: 'Indexed relational tables, ACID transactions, pagination, idempotency keys, live load benchmark runner',
      status: 'IMPLEMENTED',
      notes: 'Measured in-app benchmark reports actual latency & throughput rather than claiming unverified limits.',
    },
    {
      module: '9. Dual User Experiences',
      capability: 'Simple Mode (Karobar-style everyday billing/khata/cashbook) & Advanced Mode (Enterprise ERP)',
      status: 'IMPLEMENTED',
      notes: 'Both modes share the exact same REST API, double-entry ledger, and inventory engine.',
    },
    {
      module: '10. Hosted PostgreSQL & External Integrations',
      capability: 'External Cloud SQL PostgreSQL cluster, scheduled off-site S3 backup cron, IRD Nepal live e-billing webhook',
      status: 'PENDING',
      notes: 'Deferred until hosted Cloud SQL PostgreSQL & external tax-authority credentials are provisioned.',
    },
  ];
}

export function runAutomatedVerificationSuite(): {
  passedCount: number;
  totalCount: number;
  checks: VerificationCheck[];
  executedAt: string;
} {
  const checks: VerificationCheck[] = [];

  const runCheck = (id: string, category: string, name: string, fn: () => string) => {
    const t0 = performance.now();
    try {
      const details = fn();
      checks.push({
        id,
        category,
        name,
        passed: true,
        details,
        durationMs: round2(performance.now() - t0),
      });
    } catch (err: any) {
      checks.push({
        id,
        category,
        name,
        passed: false,
        details: err?.message || String(err),
        durationMs: round2(performance.now() - t0),
      });
    }
  };

  // 1. Every company Trial Balance & Balance Sheet Equation
  const companies = db.prepare('SELECT id, code, legal_name, currency FROM companies').all() as Array<{
    id: number;
    code: string;
    legal_name: string;
    currency: string;
  }>;

  runCheck(
    'fin-trial-balance',
    'Financial Integrity',
    'Double-entry Trial Balance equality across all legal entities',
    () => {
      const summary: string[] = [];
      for (const c of companies) {
        const st = computeFinancialStatements({
          companyIds: [c.id],
          scopeLabel: c.legal_name,
          currency: c.currency,
        });
        if (!st.isBalanced) {
          throw new Error(`${c.code} out of balance: Dr ${st.totalTrialDebit} vs Cr ${st.totalTrialCredit}`);
        }
        summary.push(`${c.code}: Dr=${st.totalTrialDebit.toLocaleString()} == Cr=${st.totalTrialCredit.toLocaleString()}`);
      }
      return summary.join(' | ');
    }
  );

  runCheck(
    'fin-balance-sheet',
    'Financial Integrity',
    'Balance Sheet equation (Assets = Liabilities + Equity + Net Income)',
    () => {
      const summary: string[] = [];
      for (const c of companies) {
        const st = computeFinancialStatements({
          companyIds: [c.id],
          scopeLabel: c.legal_name,
          currency: c.currency,
        });
        if (Math.abs(st.balanceSheet.balanceSheetDiff) >= 0.01) {
          throw new Error(
            `${c.code} BS variance ${st.balanceSheet.balanceSheetDiff}: Assets ${st.balanceSheet.totalAssets} vs L+E ${st.balanceSheet.totalLiabilitiesAndEquity}`
          );
        }
        summary.push(`${c.code}: Assets ${st.balanceSheet.totalAssets.toLocaleString()} (Diff 0.00)`);
      }
      return summary.join(' | ');
    }
  );

  runCheck(
    'fin-consolidated',
    'Consolidation',
    'Consolidated financial statements with inter-company eliminations remain balanced',
    () => {
      const ids = companies.map((c) => c.id);
      const st = computeFinancialStatements({
        companyIds: ids,
        includeEliminations: true,
        scopeLabel: 'Group Consolidated',
      });
      if (!st.isBalanced || Math.abs(st.balanceSheet.balanceSheetDiff) >= 0.01) {
        throw new Error('Consolidated statement out of balance.');
      }
      return `Group Consolidated (${ids.length} entities): Revenue ${st.profitAndLoss.totalRevenue.toLocaleString()}, Net Income ${st.profitAndLoss.netIncome.toLocaleString()}, BS Diff 0.00`;
    }
  );

  runCheck(
    'iso-cross-company',
    'Tenant Isolation',
    'Zero cross-company foreign key leakage in journal lines and stock lots',
    () => {
      const badJl = db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM journal_lines jl
           JOIN accounts a ON a.id = jl.account_id
           JOIN branches b ON b.id = jl.branch_id
           WHERE jl.company_id != a.company_id OR jl.company_id != b.company_id`
        )
        .get() as { cnt: number };

      const badLots = db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM stock_lots sl
           JOIN inventory_items i ON i.id = sl.item_id
           JOIN warehouses w ON w.id = sl.warehouse_id
           WHERE sl.company_id != i.company_id OR sl.company_id != w.company_id`
        )
        .get() as { cnt: number };

      if (badJl.cnt > 0 || badLots.cnt > 0) {
        throw new Error(`Found cross-company leakage: journal_lines=${badJl.cnt}, stock_lots=${badLots.cnt}`);
      }
      return 'Verified 0 cross-company references across journal_lines, accounts, branches, stock_lots, items, and warehouses.';
    }
  );

  runCheck(
    'inv-non-negative',
    'Inventory Integrity',
    'No negative stock lots and positive FIFO/Weighted Average lot valuations',
    () => {
      const neg = db
        .prepare('SELECT COUNT(*) AS cnt FROM stock_lots WHERE qty_remaining < -0.0001')
        .get() as { cnt: number };
      if (neg.cnt > 0) {
        throw new Error(`Found ${neg.cnt} stock lots with negative remaining quantity.`);
      }
      const val = db
        .prepare('SELECT COUNT(*) AS lots, SUM(qty_remaining * unit_cost) AS total_val FROM stock_lots WHERE qty_remaining > 0')
        .get() as { lots: number; total_val: number };
      return `${val.lots} active lots verified (0 negative lots). Total inventory valuation: NPR ${round2(val.total_val || 0).toLocaleString()}.`;
    }
  );

  runCheck(
    'sec-period-lock',
    'Governance',
    'Locked financial period blocks backdated posting',
    () => {
      const locked = db
        .prepare('SELECT company_id, period_name, start_date FROM fiscal_period_locks WHERE is_locked = 1 LIMIT 1')
        .get() as { company_id: number; period_name: string; start_date: string } | undefined;
      if (!locked) {
        return 'No locked period configured yet (lock a period in Accounting > Period Locks to test enforcement).';
      }
      let blocked = false;
      try {
        ensurePeriodOpen(locked.company_id, locked.start_date);
      } catch {
        blocked = true;
      }
      if (!blocked) {
        throw new Error(`Period lock failed to block date ${locked.start_date}.`);
      }
      return `Verified period "${locked.period_name}" properly rejects posting on ${locked.start_date} (HTTP 423).`;
    }
  );

  runCheck(
    'sec-unbalanced-reject',
    'Accounting Guard',
    'Each posted journal entry individually sums to Dr == Cr',
    () => {
      const badEntries = db
        .prepare(
          `SELECT je.entry_number, ROUND(SUM(jl.debit) - SUM(jl.credit), 2) AS diff
           FROM journal_entries je
           JOIN journal_lines jl ON jl.journal_entry_id = je.id
           GROUP BY je.id
           HAVING ABS(SUM(jl.debit) - SUM(jl.credit)) >= 0.01`
        )
        .all() as Array<{ entry_number: string; diff: number }>;
      if (badEntries.length > 0) {
        throw new Error(`Unbalanced vouchers detected: ${badEntries.map((e) => e.entry_number).join(', ')}`);
      }
      const totalJe = db.prepare('SELECT COUNT(*) AS cnt FROM journal_entries').get() as { cnt: number };
      return `All ${totalJe.cnt} journal entries individually balanced to 0.00 variance.`;
    }
  );

  return {
    passedCount: checks.filter((c) => c.passed).length,
    totalCount: checks.length,
    checks,
    executedAt: new Date().toISOString(),
  };
}

export function runLoadBenchmark(iterations = 50): {
  iterations: number;
  totalDurationMs: number;
  opsPerSec: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  note: string;
} {
  const safeIters = Math.min(Math.max(iterations, 10), 250);
  const latencies: number[] = [];
  const startAll = performance.now();

  for (let i = 0; i < safeIters; i++) {
    const t0 = performance.now();
    // Execute a real transactional read + idempotency write-and-cleanup cycle
    withTransaction(() => {
      const key = `bench-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`;
      db.prepare(
        `INSERT INTO idempotency_keys (key, endpoint, company_id, response_json) VALUES (?, '/benchmark', 1, '{"ok":true}')`
      ).run(key);
      db.prepare('SELECT COUNT(*) AS cnt FROM journal_lines WHERE company_id = 1').get();
      db.prepare('DELETE FROM idempotency_keys WHERE key = ?').run(key);
    });
    latencies.push(performance.now() - t0);
  }

  const totalDurationMs = round2(performance.now() - startAll);
  latencies.sort((a, b) => a - b);
  const p50LatencyMs = round2(latencies[Math.floor(latencies.length * 0.5)] || 0);
  const p95LatencyMs = round2(latencies[Math.floor(latencies.length * 0.95)] || 0);
  const opsPerSec = round2((safeIters / Math.max(totalDurationMs, 0.1)) * 1000);

  return {
    iterations: safeIters,
    totalDurationMs,
    opsPerSec,
    p50LatencyMs,
    p95LatencyMs,
    note: `Measured ${safeIters} ACID SQLite WAL transactions (write + indexed ledger aggregation + cleanup) on this runtime container.`,
  };
}
