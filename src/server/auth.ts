import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { db } from './db.ts';
import type { AuthUser, ErpUiMode, UserRole } from '../shared/types.ts';

const JWT_SECRET = process.env.JWT_SECRET || 'nextgen-erp-dev-signing-key-2026';

export interface AuthedRequest extends Request {
  user?: AuthUser;
}

export function signUserToken(userId: number): string {
  return jwt.sign({ uid: userId }, JWT_SECRET, { expiresIn: '12h' });
}

export function loadAuthUserById(userId: number): AuthUser | null {
  const row = db
    .prepare('SELECT id, email, full_name, role, default_mode FROM users WHERE id = ? AND is_active = 1')
    .get(userId) as
    | { id: number; email: string; full_name: string; role: UserRole; default_mode: ErpUiMode }
    | undefined;

  if (!row) return null;

  if (row.role === 'SUPER_ADMIN') {
    const allCompanies = db.prepare('SELECT id FROM companies WHERE is_active = 1').all() as Array<{ id: number }>;
    const allBranches = db.prepare('SELECT id FROM branches WHERE is_active = 1').all() as Array<{ id: number }>;
    return {
      id: row.id,
      email: row.email,
      fullName: row.full_name,
      role: row.role,
      defaultMode: row.default_mode,
      allowedCompanyIds: allCompanies.map((c) => c.id),
      allowedBranchIds: allBranches.map((b) => b.id),
    };
  }

  const perms = db
    .prepare('SELECT company_id, branch_id FROM user_permissions WHERE user_id = ?')
    .all(row.id) as Array<{ company_id: number; branch_id: number | null }>;

  const companySet = new Set<number>();
  const branchSet = new Set<number>();

  for (const p of perms) {
    companySet.add(p.company_id);
    if (p.branch_id === null) {
      const branches = db
        .prepare('SELECT id FROM branches WHERE company_id = ? AND is_active = 1')
        .all(p.company_id) as Array<{ id: number }>;
      for (const b of branches) branchSet.add(b.id);
    } else {
      branchSet.add(p.branch_id);
    }
  }

  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    defaultMode: row.default_mode,
    allowedCompanyIds: Array.from(companySet),
    allowedBranchIds: Array.from(branchSet),
  };
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { uid: number };
    const user = loadAuthUserById(payload.uid);
    if (!user) {
      res.status(401).json({ error: 'User account not found or inactive.' });
      return;
    }
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired session token.' });
  }
}

export function assertCompanyAccess(user: AuthUser, companyId: number): void {
  if (!user.allowedCompanyIds.includes(companyId)) {
    const err = new Error('Forbidden: You do not have tenant permission for this company.') as Error & {
      statusCode?: number;
    };
    err.statusCode = 403;
    throw err;
  }
}

export function assertBranchAccess(user: AuthUser, branchId: number): void {
  if (!user.allowedBranchIds.includes(branchId)) {
    const err = new Error('Forbidden: You do not have permission for this branch.') as Error & {
      statusCode?: number;
    };
    err.statusCode = 403;
    throw err;
  }
}
