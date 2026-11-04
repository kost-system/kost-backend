import express, { Request, Response } from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import {
  Room,
  Tenant,
  Invoice,
  PaymentSubmission,
  Expense,
  KostSettings,
  User,
} from './types.js';

const app = express();
const PORT = process.env.PORT || 5000;
const DB_FILE = path.join(process.cwd(), 'data.json');

app.use(cors());
app.use(express.json({ limit: '10mb' }));

export interface DbSchema {
  users: User[];
  rooms: Room[];
  tenants: Tenant[];
  invoices: Invoice[];
  submissions: PaymentSubmission[];
  expenses: Expense[];
  settings: KostSettings | null;
}

const EMPTY_DB: DbSchema = {
  users: [],
  rooms: [],
  tenants: [],
  invoices: [],
  submissions: [],
  expenses: [],
  settings: null,
};

function loadDb(): DbSchema {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(EMPTY_DB, null, 2), 'utf-8');
    return EMPTY_DB;
  }
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Failed to parse database file, resetting to empty state:', err);
    return EMPTY_DB;
  }
}

function saveDb(data: DbSchema) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// Health check
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'kost_backend',
    database: 'ready',
    timestamp: new Date().toISOString(),
  });
});

// Bootstrap / All collections
app.get('/api/bootstrap', (_req: Request, res: Response) => {
  res.json(loadDb());
});

// Settings
app.get('/api/settings', (_req: Request, res: Response) => {
  const db = loadDb();
  res.json(db.settings);
});

app.put('/api/settings', (req: Request, res: Response) => {
  const db = loadDb();
  db.settings = { ...(db.settings || ({} as KostSettings)), ...req.body };
  saveDb(db);
  res.json(db.settings);
});

// Users
app.get('/api/users', (_req: Request, res: Response) => {
  const db = loadDb();
  res.json(db.users);
});

app.post('/api/users', (req: Request, res: Response) => {
  const db = loadDb();
  const newUser: User = {
    ...req.body,
    id: req.body.id || `user-${Date.now()}`,
  };
  db.users.push(newUser);
  saveDb(db);
  res.status(201).json(newUser);
});

// Rooms
app.get('/api/rooms', (_req: Request, res: Response) => {
  const db = loadDb();
  res.json(db.rooms);
});

app.post('/api/rooms', (req: Request, res: Response) => {
  const db = loadDb();
  const newRoom: Room = {
    ...req.body,
    id: req.body.id || `room-${Date.now()}`,
  };
  db.rooms.push(newRoom);
  saveDb(db);
  res.status(201).json(newRoom);
});

app.put('/api/rooms/:id', (req: Request, res: Response) => {
  const db = loadDb();
  const index = db.rooms.findIndex((r) => r.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Room not found' });
  db.rooms[index] = { ...db.rooms[index], ...req.body };
  saveDb(db);
  res.json(db.rooms[index]);
});

app.delete('/api/rooms/:id', (req: Request, res: Response) => {
  const db = loadDb();
  db.rooms = db.rooms.filter((r) => r.id !== req.params.id);
  saveDb(db);
  res.json({ success: true });
});

// Tenants
app.get('/api/tenants', (_req: Request, res: Response) => {
  const db = loadDb();
  res.json(db.tenants);
});

app.post('/api/tenants', (req: Request, res: Response) => {
  const db = loadDb();
  const newTenant: Tenant = {
    ...req.body,
    id: req.body.id || `tenant-${Date.now()}`,
  };
  db.tenants.push(newTenant);

  if (newTenant.roomId) {
    const roomIndex = db.rooms.findIndex((r) => r.id === newTenant.roomId);
    if (roomIndex !== -1) {
      db.rooms[roomIndex].status = 'occupied';
      db.rooms[roomIndex].currentTenantId = newTenant.id;
    }
  }

  saveDb(db);
  res.status(201).json(newTenant);
});

app.put('/api/tenants/:id', (req: Request, res: Response) => {
  const db = loadDb();
  const index = db.tenants.findIndex((t) => t.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Tenant not found' });
  db.tenants[index] = { ...db.tenants[index], ...req.body };
  saveDb(db);
  res.json(db.tenants[index]);
});

app.post('/api/tenants/:id/checkout', (req: Request, res: Response) => {
  const db = loadDb();
  const index = db.tenants.findIndex((t) => t.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Tenant not found' });

  const tenant = db.tenants[index];
  tenant.status = 'inactive';

  const roomIndex = db.rooms.findIndex((r) => r.id === tenant.roomId);
  if (roomIndex !== -1) {
    db.rooms[roomIndex].status = 'available';
    db.rooms[roomIndex].currentTenantId = null;
  }

  saveDb(db);
  res.json({ success: true, tenant });
});

app.delete('/api/tenants/:id', (req: Request, res: Response) => {
  const db = loadDb();
  const tenant = db.tenants.find((t) => t.id === req.params.id);
  if (tenant && tenant.roomId) {
    const roomIndex = db.rooms.findIndex((r) => r.id === tenant.roomId);
    if (roomIndex !== -1 && db.rooms[roomIndex].currentTenantId === tenant.id) {
      db.rooms[roomIndex].status = 'available';
      db.rooms[roomIndex].currentTenantId = null;
    }
  }
  db.tenants = db.tenants.filter((t) => t.id !== req.params.id);
  saveDb(db);
  res.json({ success: true });
});

// Invoices
app.get('/api/invoices', (_req: Request, res: Response) => {
  const db = loadDb();
  res.json(db.invoices);
});

app.post('/api/invoices', (req: Request, res: Response) => {
  const db = loadDb();
  const newInvoice: Invoice = {
    ...req.body,
    id: req.body.id || `inv-${Date.now()}`,
    createdAt: req.body.createdAt || new Date().toISOString(),
  };
  db.invoices.push(newInvoice);
  saveDb(db);
  res.status(201).json(newInvoice);
});

app.post('/api/invoices/batch-generate', (req: Request, res: Response) => {
  const { periodMonth } = req.body;
  if (!periodMonth) return res.status(400).json({ error: 'periodMonth wajib diisi' });

  const db = loadDb();
  const activeTenants = db.tenants.filter((t) => t.status === 'active');
  const newInvoices: Invoice[] = [];
  let generatedCount = 0;

  activeTenants.forEach((tenant) => {
    const existing = db.invoices.find(
      (inv) => inv.tenantId === tenant.id && inv.periodMonth === periodMonth
    );
    if (!existing) {
      const room = db.rooms.find((r) => r.id === tenant.roomId);
      if (room) {
        const dueDay = db.settings?.defaultDueDay ?? 10;
        const dueDate = `${periodMonth}-${String(dueDay).padStart(2, '0')}`;
        const invNumber = `INV-${periodMonth.replace('-', '')}-${room.number}`;

        const createdInv: Invoice = {
          id: `inv-${Date.now()}-${tenant.id}`,
          invoiceNumber: invNumber,
          tenantId: tenant.id,
          roomId: room.id,
          periodMonth,
          amount: room.monthlyPrice,
          dueDate,
          status: 'unpaid',
          createdAt: new Date().toISOString(),
          notes: `Tagihan sewa kamar ${room.number} periode ${periodMonth}`,
        };
        newInvoices.push(createdInv);
        generatedCount++;
      }
    }
  });

  if (generatedCount > 0) {
    db.invoices = [...newInvoices, ...db.invoices];
    saveDb(db);
  }

  res.json({
    success: true,
    count: generatedCount,
    message: `Berhasil membuat ${generatedCount} tagihan untuk periode ${periodMonth}.`,
  });
});

app.put('/api/invoices/:id', (req: Request, res: Response) => {
  const db = loadDb();
  const index = db.invoices.findIndex((i) => i.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Invoice not found' });
  db.invoices[index] = { ...db.invoices[index], ...req.body };
  saveDb(db);
  res.json(db.invoices[index]);
});

app.delete('/api/invoices/:id', (req: Request, res: Response) => {
  const db = loadDb();
  db.invoices = db.invoices.filter((i) => i.id !== req.params.id);
  saveDb(db);
  res.json({ success: true });
});

// Submissions / Payments
app.get('/api/submissions', (_req: Request, res: Response) => {
  const db = loadDb();
  res.json(db.submissions);
});

app.post('/api/submissions', (req: Request, res: Response) => {
  const db = loadDb();
  const invoice = db.invoices.find((inv) => inv.id === req.body.invoiceId);
  if (!invoice) return res.status(404).json({ error: 'Tagihan tidak ditemukan' });
  if (invoice.status === 'paid') {
    return res.status(400).json({ error: 'Tagihan ini sudah lunas terverifikasi' });
  }

  const submission: PaymentSubmission = {
    ...req.body,
    id: req.body.id || `sub-${Date.now()}`,
    submittedAt: new Date().toISOString(),
    status: 'pending',
  };
  db.submissions.push(submission);

  invoice.status = 'pending_verification';
  invoice.latestSubmissionId = submission.id;

  saveDb(db);
  res.status(201).json(submission);
});

app.post('/api/submissions/:id/verify', (req: Request, res: Response) => {
  const { reviewerName, notes } = req.body;
  const db = loadDb();
  const subIndex = db.submissions.findIndex((s) => s.id === req.params.id);
  if (subIndex === -1) return res.status(404).json({ error: 'Pembayaran tidak ditemukan' });

  const sub = db.submissions[subIndex];
  if (sub.status === 'verified') {
    return res.status(400).json({ error: 'Pembayaran ini sudah diverifikasi sebelumnya' });
  }

  const nowISO = new Date().toISOString();
  sub.status = 'verified';
  sub.reviewedBy = reviewerName || 'Admin';
  sub.reviewedAt = nowISO;
  if (notes) {
    sub.notes = sub.notes ? `${sub.notes} | ${notes}` : notes;
  }

  const invIndex = db.invoices.findIndex((inv) => inv.id === sub.invoiceId);
  if (invIndex !== -1) {
    db.invoices[invIndex].status = 'paid';
    db.invoices[invIndex].paidAt = nowISO;
  }

  saveDb(db);
  res.json({ success: true, submission: sub });
});

app.post('/api/submissions/:id/reject', (req: Request, res: Response) => {
  const { reviewerName, rejectionReason } = req.body;
  if (!rejectionReason || !rejectionReason.trim()) {
    return res.status(400).json({ error: 'Alasan penolakan pembayaran wajib diisi.' });
  }

  const db = loadDb();
  const subIndex = db.submissions.findIndex((s) => s.id === req.params.id);
  if (subIndex === -1) return res.status(404).json({ error: 'Pembayaran tidak ditemukan' });

  const sub = db.submissions[subIndex];
  const nowISO = new Date().toISOString();
  sub.status = 'rejected';
  sub.rejectionReason = rejectionReason.trim();
  sub.reviewedBy = reviewerName || 'Admin';
  sub.reviewedAt = nowISO;

  const invIndex = db.invoices.findIndex((inv) => inv.id === sub.invoiceId);
  if (invIndex !== -1) {
    db.invoices[invIndex].status = 'rejected';
    db.invoices[invIndex].notes = `Pembayaran ditolak: ${rejectionReason.trim()}`;
  }

  saveDb(db);
  res.json({ success: true, submission: sub });
});

// Expenses
app.get('/api/expenses', (_req: Request, res: Response) => {
  const db = loadDb();
  res.json(db.expenses);
});

app.post('/api/expenses', (req: Request, res: Response) => {
  const db = loadDb();
  const exp: Expense = {
    ...req.body,
    id: req.body.id || `exp-${Date.now()}`,
  };
  db.expenses.push(exp);
  saveDb(db);
  res.status(201).json(exp);
});

app.put('/api/expenses/:id', (req: Request, res: Response) => {
  const db = loadDb();
  const index = db.expenses.findIndex((e) => e.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Expense not found' });
  db.expenses[index] = { ...db.expenses[index], ...req.body };
  saveDb(db);
  res.json(db.expenses[index]);
});

app.delete('/api/expenses/:id', (req: Request, res: Response) => {
  const db = loadDb();
  db.expenses = db.expenses.filter((e) => e.id !== req.params.id);
  saveDb(db);
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`🚀 Kost Backend API running on http://localhost:${PORT}`);
});
