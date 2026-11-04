import express, { Request, Response } from 'express';
import cors from 'cors';
import { supabase, isSupabaseConfigured } from './supabase.js';
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

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/api/health', async (_req: Request, res: Response) => {
  let dbStatus = 'disconnected';
  if (isSupabaseConfigured && supabase) {
    const { error } = await supabase.from('rooms').select('count', { count: 'exact', head: true });
    dbStatus = error ? `error: ${error.message}` : 'connected (Supabase)';
  }
  res.json({
    status: 'ok',
    service: 'kost_backend',
    database: dbStatus,
    timestamp: new Date().toISOString(),
  });
});

// Bootstrap / All collections
app.get('/api/bootstrap', async (_req: Request, res: Response) => {
  if (!supabase) {
    return res.json({ users: [], rooms: [], tenants: [], invoices: [], submissions: [], expenses: [], settings: null });
  }

  try {
    const [usersRes, roomsRes, tenantsRes, invoicesRes, submissionsRes, expensesRes, settingsRes] = await Promise.all([
      supabase.from('users').select('*'),
      supabase.from('rooms').select('*'),
      supabase.from('tenants').select('*'),
      supabase.from('invoices').select('*'),
      supabase.from('payment_submissions').select('*'),
      supabase.from('expenses').select('*'),
      supabase.from('settings').select('*').limit(1).maybeSingle(),
    ]);

    // Format snake_case to camelCase for rooms
    const rooms = (roomsRes.data || []).map((r: any) => ({
      id: r.id,
      number: r.number,
      floor: r.floor,
      type: r.type,
      monthlyPrice: Number(r.monthly_price),
      status: r.status,
      currentTenantId: r.current_tenant_id,
      notes: r.notes,
    }));

    // Format tenants
    const tenants = (tenantsRes.data || []).map((t: any) => ({
      id: t.id,
      name: t.name,
      phone: t.phone,
      email: t.email,
      roomId: t.room_id,
      startDate: t.start_date,
      status: t.status,
      emergencyContact: t.emergency_contact,
      notes: t.notes,
    }));

    // Format invoices
    const invoices = (invoicesRes.data || []).map((i: any) => ({
      id: i.id,
      invoiceNumber: i.invoice_number,
      tenantId: i.tenant_id,
      roomId: i.room_id,
      periodMonth: i.period_month,
      amount: Number(i.amount),
      dueDate: i.due_date,
      status: i.status,
      createdAt: i.created_at,
      paidAt: i.paid_at,
      latestSubmissionId: i.latest_submission_id,
      notes: i.notes,
    }));

    // Format submissions
    const submissions = (submissionsRes.data || []).map((s: any) => ({
      id: s.id,
      invoiceId: s.invoice_id,
      tenantId: s.tenant_id,
      amount: Number(s.amount),
      paymentDate: s.payment_date,
      method: s.method,
      senderBank: s.sender_bank,
      senderName: s.sender_name,
      proofImageUrl: s.proof_image_url,
      submittedAt: s.submitted_at,
      status: s.status,
      reviewedBy: s.reviewed_by,
      reviewedAt: s.reviewed_at,
      rejectionReason: s.rejection_reason,
      notes: s.notes,
    }));

    // Format expenses
    const expenses = (expensesRes.data || []).map((e: any) => ({
      id: e.id,
      description: e.description,
      amount: Number(e.amount),
      date: e.date,
      category: e.category,
      notes: e.notes,
      recordedBy: e.recorded_by,
    }));

    // Format settings
    let settings = null;
    if (settingsRes.data) {
      const s = settingsRes.data;
      settings = {
        kostName: s.kost_name,
        tagline: s.tagline,
        address: s.address,
        phone: s.phone,
        email: s.email,
        bankName: s.bank_name,
        bankAccountNumber: s.bank_account_number,
        bankAccountName: s.bank_account_name,
        qrisNmid: s.qris_nmid,
        qrisMerchantName: s.qris_merchant_name,
        qrisImageUrl: s.qris_image_url,
        defaultDueDay: s.default_due_day,
        paymentInstructions: s.payment_instructions,
      };
    }

    res.json({
      users: usersRes.data || [],
      rooms,
      tenants,
      invoices,
      submissions,
      expenses,
      settings,
    });
  } catch (err: any) {
    console.error('Error fetching bootstrap data from Supabase:', err);
    res.status(500).json({ error: err.message });
  }
});

// Rooms
app.get('/api/rooms', async (_req: Request, res: Response) => {
  if (!supabase) return res.json([]);
  const { data, error } = await supabase.from('rooms').select('*').order('number');
  if (error) return res.status(500).json({ error: error.message });
  const formatted = (data || []).map((r: any) => ({
    id: r.id,
    number: r.number,
    floor: r.floor,
    type: r.type,
    monthlyPrice: Number(r.monthly_price),
    status: r.status,
    currentTenantId: r.current_tenant_id,
    notes: r.notes,
  }));
  res.json(formatted);
});

app.post('/api/rooms', async (req: Request, res: Response) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not connected' });
  const { number, floor, type, monthlyPrice, status, notes } = req.body;
  const { data, error } = await supabase
    .from('rooms')
    .insert([
      {
        number,
        floor: Number(floor) || 1,
        type,
        monthly_price: Number(monthlyPrice),
        status: status || 'available',
        notes,
      },
    ])
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

app.put('/api/rooms/:id', async (req: Request, res: Response) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not connected' });
  const updates: any = {};
  if (req.body.number !== undefined) updates.number = req.body.number;
  if (req.body.floor !== undefined) updates.floor = Number(req.body.floor);
  if (req.body.type !== undefined) updates.type = req.body.type;
  if (req.body.monthlyPrice !== undefined) updates.monthly_price = Number(req.body.monthlyPrice);
  if (req.body.status !== undefined) updates.status = req.body.status;
  if (req.body.notes !== undefined) updates.notes = req.body.notes;

  const { data, error } = await supabase
    .from('rooms')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/rooms/:id', async (req: Request, res: Response) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not connected' });
  const { error } = await supabase.from('rooms').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// Tenants
app.get('/api/tenants', async (_req: Request, res: Response) => {
  if (!supabase) return res.json([]);
  const { data, error } = await supabase.from('tenants').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  const formatted = (data || []).map((t: any) => ({
    id: t.id,
    name: t.name,
    phone: t.phone,
    email: t.email,
    roomId: t.room_id,
    startDate: t.start_date,
    status: t.status,
    emergencyContact: t.emergency_contact,
    notes: t.notes,
  }));
  res.json(formatted);
});

app.post('/api/tenants', async (req: Request, res: Response) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not connected' });
  const { name, phone, email, roomId, startDate, emergencyContact, notes } = req.body;
  const { data, error } = await supabase
    .from('tenants')
    .insert([
      {
        name,
        phone,
        email,
        room_id: roomId || null,
        start_date: startDate || new Date().toISOString().split('T')[0],
        status: 'active',
        emergency_contact: emergencyContact,
        notes,
      },
    ])
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  if (roomId) {
    await supabase.from('rooms').update({ status: 'occupied', current_tenant_id: data.id }).eq('id', roomId);
  }

  res.status(201).json(data);
});

app.post('/api/tenants/:id/checkout', async (req: Request, res: Response) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not connected' });
  const { data: tenant, error: fetchErr } = await supabase
    .from('tenants')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (fetchErr || !tenant) return res.status(404).json({ error: 'Tenant not found' });

  await supabase.from('tenants').update({ status: 'inactive' }).eq('id', req.params.id);
  if (tenant.room_id) {
    await supabase.from('rooms').update({ status: 'available', current_tenant_id: null }).eq('id', tenant.room_id);
  }

  res.json({ success: true });
});

// Invoices
app.get('/api/invoices', async (_req: Request, res: Response) => {
  if (!supabase) return res.json([]);
  const { data, error } = await supabase.from('invoices').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/invoices', async (req: Request, res: Response) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not connected' });
  const { tenantId, roomId, periodMonth, amount, dueDate, notes, invoiceNumber } = req.body;
  const { data, error } = await supabase
    .from('invoices')
    .insert([
      {
        invoice_number: invoiceNumber || `INV-${Date.now().toString().slice(-6)}`,
        tenant_id: tenantId,
        room_id: roomId,
        period_month: periodMonth,
        amount: Number(amount),
        due_date: dueDate,
        status: 'unpaid',
        notes,
      },
    ])
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// Expenses
app.get('/api/expenses', async (_req: Request, res: Response) => {
  if (!supabase) return res.json([]);
  const { data, error } = await supabase.from('expenses').select('*').order('date', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/expenses', async (req: Request, res: Response) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not connected' });
  const { description, amount, date, category, notes, recordedBy } = req.body;
  const { data, error } = await supabase
    .from('expenses')
    .insert([
      {
        description,
        amount: Number(amount),
        date: date || new Date().toISOString().split('T')[0],
        category: category || 'operational',
        notes,
        recorded_by: recordedBy || 'Admin',
      },
    ])
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

app.listen(PORT, () => {
  console.log(`🚀 Kost Backend API running on http://localhost:${PORT}`);
  console.log(`📡 Database mode: ${isSupabaseConfigured ? 'Supabase Live' : 'Offline / Mock'}`);
});
