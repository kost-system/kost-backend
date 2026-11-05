import express, { Request, Response } from 'express';
import cors from 'cors';
import { supabase, isSupabaseConfigured } from './supabase.js';
import { snap, coreApi, isMidtransConfigured, verifyMidtransSignature } from './midtrans.js';
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
    midtrans: isMidtransConfigured ? 'ready' : 'missing_keys',
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

    const invoices = (invoicesRes.data || []).map((i: any) => ({
      id: i.id,
      invoiceNumber: i.invoice_number,
      tenantId: i.tenant_id,
      roomId: i.room_id,
      periodMonth: i.period_month,
      amount: Number(i.amount),
      dueDate: i.due_date,
      status: i.status,
      snapToken: i.snap_token,
      snapRedirectUrl: i.snap_redirect_url,
      createdAt: i.created_at,
      paidAt: i.paid_at,
      latestSubmissionId: i.latest_submission_id,
      notes: i.notes,
    }));

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

    const expenses = (expensesRes.data || []).map((e: any) => ({
      id: e.id,
      description: e.description,
      amount: Number(e.amount),
      date: e.date,
      category: e.category,
      notes: e.notes,
      recordedBy: e.recorded_by,
    }));

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
      users: (usersRes.data || []).map((u: any) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        phone: u.phone,
        role: u.role,
        avatar: u.avatar,
      })),
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

// ==============================================================================
// AUTHENTICATION & ADMIN USER MANAGEMENT (OWNER ONLY)
// ==============================================================================

// 1. Login Admin
app.post('/api/auth/login', async (req: Request, res: Response) => {
  if (!supabase) return res.status(500).json({ error: 'Database offline' });
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email dan password wajib diisi' });
  }

  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('email', email.trim().toLowerCase())
    .maybeSingle();

  if (error || !user) {
    return res.status(401).json({ error: 'Email atau password salah' });
  }

  // Verifikasi password
  if (user.password !== password) {
    return res.status(401).json({ error: 'Email atau password salah' });
  }

  // Kembalikan profil tanpa password
  const { password: _, ...userSafe } = user;
  res.json({
    user: userSafe,
    token: `token-${user.id}-${Date.now()}`,
  });
});

// 2. Daftar Users Admin (GET /api/users)
app.get('/api/users', async (_req: Request, res: Response) => {
  if (!supabase) return res.status(500).json({ error: 'Database offline' });
  const { data, error } = await supabase
    .from('users')
    .select('id, name, email, phone, role, avatar, created_at, updated_at')
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 3. Tambah Admin Baru (POST /api/users) - Digunakan oleh Owner
app.post('/api/users', async (req: Request, res: Response) => {
  if (!supabase) return res.status(500).json({ error: 'Database offline' });
  const { name, email, password, phone, role } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Nama, email, dan password wajib diisi' });
  }

  const cleanEmail = email.trim().toLowerCase();
  const assignedRole = role === 'owner' ? 'owner' : (role === 'manager' ? 'manager' : 'manager');

  const { data, error } = await supabase
    .from('users')
    .insert([
      {
        name,
        email: cleanEmail,
        password,
        phone: phone || '',
        role: assignedRole,
      },
    ])
    .select('id, name, email, phone, role, avatar, created_at')
    .single();

  if (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Email sudah terdaftar untuk pengguna lain' });
    }
    return res.status(500).json({ error: error.message });
  }

  res.status(201).json(data);
});

// 4. Update Admin (PUT /api/users/:id) - Ganti password atau peran
app.put('/api/users/:id', async (req: Request, res: Response) => {
  if (!supabase) return res.status(500).json({ error: 'Database offline' });
  const updates: any = {};
  if (req.body.name !== undefined) updates.name = req.body.name;
  if (req.body.phone !== undefined) updates.phone = req.body.phone;
  if (req.body.role !== undefined) updates.role = req.body.role;
  if (req.body.password) updates.password = req.body.password;
  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('users')
    .update(updates)
    .eq('id', req.params.id)
    .select('id, name, email, phone, role, avatar, updated_at')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 5. Hapus Admin (DELETE /api/users/:id)
app.delete('/api/users/:id', async (req: Request, res: Response) => {
  if (!supabase) return res.status(500).json({ error: 'Database offline' });

  // Cegah menghapus superadmin utama
  const { data: user } = await supabase.from('users').select('role, email').eq('id', req.params.id).maybeSingle();
  if (user?.email === 'owner@kost.com') {
    return res.status(400).json({ error: 'Akun Superadmin Utama tidak dapat dihapus' });
  }

  const { error } = await supabase.from('users').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// SETTINGS (GET & PUT)
app.get('/api/settings', async (_req: Request, res: Response) => {
  if (!supabase) return res.status(500).json({ error: 'Database offline' });
  const { data, error } = await supabase.from('settings').select('*').limit(1).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.json(null);
  res.json({
    kostName: data.kost_name,
    tagline: data.tagline,
    address: data.address,
    phone: data.phone,
    email: data.email,
    bankName: data.bank_name,
    bankAccountNumber: data.bank_account_number,
    bankAccountName: data.bank_account_name,
    qrisNmid: data.qris_nmid,
    qrisMerchantName: data.qris_merchant_name,
    qrisImageUrl: data.qris_image_url,
    defaultDueDay: data.default_due_day,
    paymentInstructions: data.payment_instructions,
  });
});

app.put('/api/settings', async (req: Request, res: Response) => {
  if (!supabase) return res.status(500).json({ error: 'Database offline' });
  const b = req.body;
  const updates: any = { id: 1 };
  if (b.kostName !== undefined) updates.kost_name = b.kostName;
  if (b.tagline !== undefined) updates.tagline = b.tagline;
  if (b.address !== undefined) updates.address = b.address;
  if (b.phone !== undefined) updates.phone = b.phone;
  if (b.email !== undefined) updates.email = b.email;
  if (b.bankName !== undefined) updates.bank_name = b.bankName;
  if (b.bankAccountNumber !== undefined) updates.bank_account_number = b.bankAccountNumber;
  if (b.bankAccountName !== undefined) updates.bank_account_name = b.bankAccountName;
  if (b.qrisNmid !== undefined) updates.qris_nmid = b.qrisNmid;
  if (b.qrisMerchantName !== undefined) updates.qris_merchant_name = b.qrisMerchantName;
  if (b.qrisImageUrl !== undefined) updates.qris_image_url = b.qrisImageUrl;
  if (b.defaultDueDay !== undefined) updates.default_due_day = Number(b.defaultDueDay);
  if (b.paymentInstructions !== undefined) updates.payment_instructions = b.paymentInstructions;
  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('settings')
    .upsert([updates], { onConflict: 'id' })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
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

// Tenants (GET, POST, PUT, DELETE, CHECKOUT)
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

app.put('/api/tenants/:id', async (req: Request, res: Response) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not connected' });
  const b = req.body;
  const updates: any = {};
  if (b.name !== undefined) updates.name = b.name;
  if (b.phone !== undefined) updates.phone = b.phone;
  if (b.email !== undefined) updates.email = b.email;
  if (b.roomId !== undefined) updates.room_id = b.roomId || null;
  if (b.startDate !== undefined) updates.start_date = b.startDate;
  if (b.status !== undefined) updates.status = b.status;
  if (b.emergencyContact !== undefined) updates.emergency_contact = b.emergencyContact;
  if (b.notes !== undefined) updates.notes = b.notes;
  updates.updated_at = new Date().toISOString();

  // Check if room changed
  const { data: currentTenant } = await supabase.from('tenants').select('room_id').eq('id', req.params.id).single();

  const { data, error } = await supabase
    .from('tenants')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Update room occupancy if room changed
  if (b.roomId !== undefined && currentTenant && currentTenant.room_id !== b.roomId) {
    if (currentTenant.room_id) {
      await supabase.from('rooms').update({ status: 'available', current_tenant_id: null }).eq('id', currentTenant.room_id);
    }
    if (b.roomId) {
      await supabase.from('rooms').update({ status: 'occupied', current_tenant_id: req.params.id }).eq('id', b.roomId);
    }
  }

  res.json(data);
});

app.delete('/api/tenants/:id', async (req: Request, res: Response) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not connected' });
  const { data: tenant } = await supabase.from('tenants').select('room_id').eq('id', req.params.id).single();
  if (tenant && tenant.room_id) {
    await supabase.from('rooms').update({ status: 'available', current_tenant_id: null }).eq('id', tenant.room_id);
  }
  const { error } = await supabase.from('tenants').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
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
app.get('/api/invoices', async (req: Request, res: Response) => {
  if (!supabase) return res.json([]);
  let query = supabase.from('invoices').select('*, rooms(number, floor, type), tenants(name, phone, email)').order('created_at', { ascending: false });
  
  if (req.query.tenantId) {
    query = query.eq('tenant_id', req.query.tenantId as string);
  }
  if (req.query.periodMonth) {
    query = query.eq('period_month', req.query.periodMonth as string);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  
  // Format field names agar konsisten dengan frontend camelCase
  const formatted = (data || []).map((inv: any) => ({
    id: inv.id,
    invoiceNumber: inv.invoice_number,
    tenantId: inv.tenant_id,
    roomId: inv.room_id,
    periodMonth: inv.period_month,
    amount: Number(inv.amount),
    dueDate: inv.due_date,
    status: inv.status,
    notes: inv.notes,
    paidAt: inv.paid_at,
    createdAt: inv.created_at,
    room: inv.rooms,
    tenant: inv.tenants,
  }));

  res.json(formatted);
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

app.put('/api/invoices/:id', async (req: Request, res: Response) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not connected' });
  const { data, error } = await supabase
    .from('invoices')
    .update(req.body)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/invoices/:id', async (req: Request, res: Response) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not connected' });
  const { error } = await supabase.from('invoices').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ==============================================================================
// MIDTRANS INTEGRATION ENDPOINTS
// ==============================================================================

app.post('/api/payments/midtrans/create-snap', async (req: Request, res: Response) => {
  if (!isMidtransConfigured || !snap) {
    return res.status(503).json({
      error: 'Midtrans belum dikonfigurasi. Periksa MIDTRANS_SERVER_KEY di .env',
    });
  }
  if (!supabase) return res.status(500).json({ error: 'Supabase not connected' });

  const { invoiceId, tenantId, amount, preferredMethod } = req.body;

  try {
    let grossAmount = Number(amount) || 1500000;
    let orderId = `INV-${Date.now().toString().slice(-6)}`;
    let customerName = 'Penghuni Kost';
    let customerPhone = '08123456789';
    let customerEmail = 'penghuni@kost.com';
    let itemName = 'Sewa Kamar Kost';

    if (invoiceId) {
      const { data: invoice } = await supabase
        .from('invoices')
        .select('*, tenants(name, email, phone), rooms(number)')
        .eq('id', invoiceId)
        .maybeSingle();

      if (invoice) {
        if (invoice.status === 'paid') {
          return res.status(400).json({ error: 'Tagihan sudah lunas' });
        }
        grossAmount = Math.round(Number(invoice.amount));
        orderId = `${invoice.invoice_number}-${Date.now().toString().slice(-4)}`;
        customerName = invoice.tenants?.name || customerName;
        customerPhone = invoice.tenants?.phone || customerPhone;
        customerEmail = invoice.tenants?.email || customerEmail;
        itemName = `Sewa Kamar ${invoice.rooms?.number || ''} (${invoice.period_month})`;
      }
    } else if (tenantId) {
      const { data: tenant } = await supabase
        .from('tenants')
        .select('*, rooms(id, number, monthly_price)')
        .eq('id', tenantId)
        .maybeSingle();

      if (tenant) {
        customerName = tenant.name || customerName;
        customerPhone = tenant.phone || customerPhone;
        customerEmail = tenant.email || customerEmail;
        grossAmount = Math.round(Number(tenant.rooms?.monthly_price) || grossAmount);
        
        // Cari atau buat tagihan bulan ini agar tersambung ke sistem invoice
        const currentPeriod = new Date().toISOString().slice(0, 7); // e.g. "2026-11"
        let { data: currentInvoice } = await supabase
          .from('invoices')
          .select('*')
          .eq('tenant_id', tenant.id)
          .eq('period_month', currentPeriod)
          .maybeSingle();

        if (!currentInvoice) {
          const invNumber = `INV-${currentPeriod.replace('-', '')}-${tenant.phone?.slice(-4) || 'TEN'}`;
          const { data: newInv } = await supabase
            .from('invoices')
            .insert([
              {
                invoice_number: invNumber,
                tenant_id: tenant.id,
                room_id: tenant.rooms?.id || tenant.room_id,
                period_month: currentPeriod,
                amount: grossAmount,
                due_date: `${currentPeriod}-10`,
                status: 'unpaid',
                notes: 'Generated via Portal Penghuni',
              },
            ])
            .select()
            .single();
          currentInvoice = newInv;
        }

        if (currentInvoice) {
          orderId = `${currentInvoice.invoice_number}-${Date.now().toString().slice(-4)}`;
        } else {
          orderId = `KST-${tenant.phone?.slice(-4) || 'TEN'}-${Date.now().toString().slice(-5)}`;
        }
        itemName = `Sewa Kamar ${tenant.rooms?.number || ''} (${currentPeriod})`;
      }
    }

    // Filter payment methods jika pengguna memilih channel spesifik
    const enabledPayments: string[] = [];
    if (preferredMethod === 'qris') {
      enabledPayments.push('gopay', 'shopeepay', 'other_qris');
    } else if (preferredMethod === 'briva' || preferredMethod === 'va') {
      enabledPayments.push('bri_va', 'bca_va', 'bni_va', 'echannel');
    }

    const parameter: any = {
      transaction_details: {
        order_id: orderId,
        gross_amount: grossAmount,
      },
      customer_details: {
        first_name: customerName,
        phone: customerPhone,
        email: customerEmail,
      },
      item_details: [
        {
          id: orderId,
          price: grossAmount,
          quantity: 1,
          name: itemName,
        },
      ],
    };

    if (enabledPayments.length > 0) {
      parameter.enabled_payments = enabledPayments;
    }

    const transaction = await snap.createTransaction(parameter);

    if (invoiceId) {
      await supabase
        .from('invoices')
        .update({
          snap_token: transaction.token,
          snap_redirect_url: transaction.redirect_url,
        })
        .eq('id', invoiceId);
    }

    res.json({
      token: transaction.token,
      redirect_url: transaction.redirect_url,
      orderId,
    });
  } catch (err: any) {
    console.error('Midtrans Snap Error:', err);
    res.status(500).json({ error: err.message || 'Gagal membuat transaksi Midtrans' });
  }
});

/**
 * 2. CREATE DIRECT QRIS CHARGE (Midtrans Core API)
 */
app.post('/api/payments/midtrans/charge-qris', async (req: Request, res: Response) => {
  if (!isMidtransConfigured || !coreApi) {
    return res.status(503).json({ error: 'Midtrans belum dikonfigurasi. Periksa kredensial di .env' });
  }
  if (!supabase) return res.status(500).json({ error: 'Database offline' });

  const { tenantId, amount, invoiceId } = req.body;

  try {
    // Cari data tenant & tagihan
    const { data: tenant } = await supabase.from('tenants').select('*, rooms(number)').eq('id', tenantId).maybeSingle();
    let grossAmount = Number(amount);
    let orderId = `QRIS-${Date.now()}`;

    if (invoiceId) {
      const { data: inv } = await supabase.from('invoices').select('*').eq('id', invoiceId).maybeSingle();
      if (inv) {
        grossAmount = Number(inv.amount);
        orderId = `${inv.invoice_number}-QRIS-${Date.now().toString().slice(-4)}`;
      }
    }

    if (!grossAmount || grossAmount <= 0) {
      grossAmount = 1500000;
    }

    const parameter = {
      payment_type: 'qris',
      transaction_details: {
        order_id: orderId,
        gross_amount: Math.round(grossAmount),
      },
      qris: {
        acquirer: 'gopay',
      },
      customer_details: {
        first_name: tenant?.name || 'Penghuni Kost',
        phone: tenant?.phone || '08123456789',
        email: tenant?.email || 'penghuni@kost.com',
      },
    };

    const chargeResponse = await coreApi.charge(parameter);

    // Ambil URL QR Code dari response Midtrans
    const qrAction = chargeResponse.actions?.find((a: any) => a.name === 'generate-qr-code');
    const qrUrl = qrAction?.url || '';

    res.json({
      orderId: chargeResponse.order_id,
      transactionId: chargeResponse.transaction_id,
      grossAmount: chargeResponse.gross_amount,
      qrString: chargeResponse.qr_string || '',
      qrUrl,
      transactionStatus: chargeResponse.transaction_status,
      expireTime: chargeResponse.expiry_time,
    });
  } catch (err: any) {
    console.error('Midtrans QRIS Charge Error:', err);
    res.status(500).json({ error: err.message || 'Gagal membuat QRIS Midtrans' });
  }
});

/**
 * 3. CREATE DIRECT BRIVA CHARGE (Midtrans Core API)
 */
app.post('/api/payments/midtrans/charge-briva', async (req: Request, res: Response) => {
  if (!isMidtransConfigured || !coreApi) {
    return res.status(503).json({ error: 'Midtrans belum dikonfigurasi. Periksa kredensial di .env' });
  }
  if (!supabase) return res.status(500).json({ error: 'Database offline' });

  const { tenantId, amount, invoiceId } = req.body;

  try {
    const { data: tenant } = await supabase.from('tenants').select('*, rooms(number)').eq('id', tenantId).maybeSingle();
    let grossAmount = Number(amount);
    let orderId = `BRIVA-${Date.now()}`;

    if (invoiceId) {
      const { data: inv } = await supabase.from('invoices').select('*').eq('id', invoiceId).maybeSingle();
      if (inv) {
        grossAmount = Number(inv.amount);
        orderId = `${inv.invoice_number}-BRIVA-${Date.now().toString().slice(-4)}`;
      }
    }

    if (!grossAmount || grossAmount <= 0) {
      grossAmount = 1500000;
    }

    const parameter = {
      payment_type: 'bank_transfer',
      bank_transfer: {
        bank: 'bri',
      },
      transaction_details: {
        order_id: orderId,
        gross_amount: Math.round(grossAmount),
      },
      customer_details: {
        first_name: tenant?.name || 'Penghuni Kost',
        phone: tenant?.phone || '08123456789',
        email: tenant?.email || 'penghuni@kost.com',
      },
    };

    const chargeResponse = await coreApi.charge(parameter);

    const vaNumber = chargeResponse.va_numbers?.[0]?.va_number || '';

    res.json({
      orderId: chargeResponse.order_id,
      transactionId: chargeResponse.transaction_id,
      grossAmount: chargeResponse.gross_amount,
      vaNumber,
      bank: 'BRI',
      transactionStatus: chargeResponse.transaction_status,
      expireTime: chargeResponse.expiry_time,
    });
  } catch (err: any) {
    console.error('Midtrans BRIVA Charge Error:', err);
    res.status(500).json({ error: err.message || 'Gagal membuat BRIVA Midtrans' });
  }
});

/**
 * 4. CHECK TRANSACTION STATUS (Real-time check)
 */
app.get('/api/payments/midtrans/status/:orderId', async (req: Request, res: Response) => {
  if (!isMidtransConfigured || !coreApi) {
    return res.status(503).json({ error: 'Midtrans belum dikonfigurasi' });
  }
  try {
    const status = await coreApi.transaction.status(req.params.orderId);
    
    // Sinkronkan langsung ke database jika statusnya settlement atau capture
    if (supabase && (status.transaction_status === 'settlement' || status.transaction_status === 'capture')) {
      const baseInvNumber = req.params.orderId.split('-').slice(0, 3).join('-');
      const { data: invoice } = await supabase
        .from('invoices')
        .select('*')
        .or(`invoice_number.eq.${baseInvNumber},invoice_number.eq.${req.params.orderId}`)
        .maybeSingle();

      if (invoice && invoice.status !== 'paid') {
        const { data: sub } = await supabase
          .from('payment_submissions')
          .upsert(
            [
              {
                invoice_id: invoice.id,
                tenant_id: invoice.tenant_id,
                amount: Number(status.gross_amount),
                payment_date: new Date().toISOString().split('T')[0],
                method: status.payment_type === 'qris' ? 'midtrans_qris' : 'midtrans_va',
                payment_gateway: 'midtrans',
                midtrans_transaction_id: status.transaction_id,
                midtrans_order_id: req.params.orderId,
                midtrans_payment_type: status.payment_type,
                status: 'settlement',
                raw_response: status,
                notes: `Auto-verified via polling (${status.payment_type})`,
              },
            ],
            { onConflict: 'midtrans_transaction_id' }
          )
          .select()
          .single();

        await supabase
          .from('invoices')
          .update({
            status: 'paid',
            paid_at: new Date().toISOString(),
            latest_submission_id: sub?.id || null,
          })
          .eq('id', invoice.id);
        console.log(`✅ Auto-verified invoice ${invoice.invoice_number} via status polling!`);
      }
    }

    res.json(status);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Gagal mengecek status transaksi' });
  }
});

app.post('/api/payments/midtrans/notification', async (req: Request, res: Response) => {
  const notification = req.body;
  if (!supabase) return res.status(500).json({ error: 'Database offline' });

  const {
    order_id,
    status_code,
    gross_amount,
    signature_key,
    transaction_status,
    transaction_id,
    payment_type,
    fraud_status,
  } = notification;

  const isValid = verifyMidtransSignature(order_id, status_code, gross_amount, signature_key);
  if (!isValid) {
    console.warn(`🚨 Invalid Midtrans Signature for order: ${order_id}`);
    return res.status(403).json({ error: 'Invalid signature key' });
  }

  try {
    const baseInvNumber = order_id.split('-').slice(0, 3).join('-');
    const { data: invoice } = await supabase
      .from('invoices')
      .select('*')
      .or(`invoice_number.eq.${baseInvNumber},invoice_number.eq.${order_id}`)
      .single();

    if (!invoice) {
      console.warn(`Invoice not found for order ${order_id}`);
      return res.status(404).json({ error: 'Invoice not found' });
    }

    if (invoice.status === 'paid') {
      return res.status(200).json({ message: 'Transaction already settled' });
    }

    let isSuccess = false;

    if (transaction_status === 'capture') {
      if (fraud_status === 'accept') {
        isSuccess = true;
      }
    } else if (transaction_status === 'settlement') {
      isSuccess = true;
    }

    const { data: submission } = await supabase
      .from('payment_submissions')
      .upsert(
        [
          {
            invoice_id: invoice.id,
            tenant_id: invoice.tenant_id,
            amount: Number(gross_amount),
            payment_date: new Date().toISOString().split('T')[0],
            method: payment_type === 'qris' ? 'midtrans_qris' : 'midtrans_va',
            payment_gateway: 'midtrans',
            midtrans_transaction_id: transaction_id,
            midtrans_order_id: order_id,
            midtrans_payment_type: payment_type,
            status: isSuccess ? 'settlement' : 'pending',
            raw_response: notification,
            notes: `Midtrans payment via ${payment_type} (${transaction_status})`,
          },
        ],
        { onConflict: 'midtrans_transaction_id' }
      )
      .select()
      .single();

    if (isSuccess) {
      await supabase
        .from('invoices')
        .update({
          status: 'paid',
          paid_at: new Date().toISOString(),
          latest_submission_id: submission?.id || null,
        })
        .eq('id', invoice.id);
      console.log(`✅ Invoice ${invoice.invoice_number} successfully paid via Midtrans!`);
    }

    res.status(200).json({ status: 'ok' });
  } catch (err: any) {
    console.error('Error handling Midtrans webhook:', err);
    res.status(500).json({ error: err.message });
  }
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
  console.log(`💳 Midtrans Gateway: ${isMidtransConfigured ? 'Configured & Active' : 'Waiting for Keys'}`);
});
