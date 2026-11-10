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
import { sendWhatsAppMessage, formatIndoDate, formatRentalPeriod } from './services/whatsappService.js';
import { generateReceiptImageBase64 } from './services/receiptImageService.js';
import cron from 'node-cron';

const app = express();
const PORT = process.env.PORT || 5000;

// CORS protection: izinkan frontend terdaftar, localhost, dan mobile/server-to-server (origin null/undefined)
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:5173',
  process.env.FRONTEND_DASHBOARD_URL,
  process.env.FRONTEND_LANDING_URL,
].filter(Boolean) as string[];

app.use(
  cors({
    origin: (origin, callback) => {
      // Izinkan webhook Midtrans, server-to-server fetch, atau tool seperti Postman yang tidak mengirim origin header
      if (!origin) return callback(null, true);

      // Izinkan origin jika cocok atau match subdomain Vercel milik project
      const isAllowed =
        allowedOrigins.includes(origin) ||
        origin.endsWith('.vercel.app');

      if (isAllowed) {
        return callback(null, true);
      }
      return callback(new Error(`CORS blocked: Origin ${origin} not allowed`));
    },
    credentials: true,
  })
);
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
      hasPassword: Boolean(t.password && t.password.trim().length > 0),
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

// 1b. Autentikasi Tenant / Penghuni Portal
app.post('/api/auth/tenant-check', async (req: Request, res: Response) => {
  if (!supabase) return res.status(500).json({ error: 'Database offline' });
  const { phone } = req.body;

  if (!phone) {
    return res.status(400).json({ error: 'Nomor telepon wajib diisi' });
  }

  const cleanPhone = phone.replace(/[^0-9]/g, '');

  // Ambil hanya kolom yang pasti ada agar tidak error jika relasi rooms null atau kolom password baru dibuat
  const { data: tenants, error } = await supabase
    .from('tenants')
    .select('id, name, phone, email, room_id, status, password')
    .eq('status', 'active');

  if (error || !tenants) {
    console.error('Error in /api/auth/tenant-check:', error);
    // Fallback toleran jika kolom password belum ada di Supabase
    const { data: fallbackTenants, error: fbError } = await supabase
      .from('tenants')
      .select('id, name, phone, email, room_id, status')
      .eq('status', 'active');

    if (fbError || !fallbackTenants) {
      return res.status(500).json({ error: 'Gagal mengambil data penghuni dari database' });
    }

    const matchedFb = fallbackTenants.find((t: any) => {
      const cleanDb = (t.phone || '').replace(/[^0-9]/g, '');
      return cleanDb === cleanPhone || cleanDb.slice(-8) === cleanPhone.slice(-8);
    });

    if (!matchedFb) {
      return res.status(404).json({ error: 'Nomor HP tidak ditemukan dalam daftar penghuni aktif.' });
    }

    return res.json({
      tenantId: matchedFb.id,
      name: matchedFb.name,
      hasPassword: false,
    });
  }

  const matched = tenants.find((t: any) => {
    const cleanDb = (t.phone || '').replace(/[^0-9]/g, '');
    return cleanDb === cleanPhone || cleanDb.slice(-8) === cleanPhone.slice(-8);
  });

  if (!matched) {
    return res.status(404).json({ error: 'Nomor HP tidak ditemukan dalam daftar penghuni aktif.' });
  }

  res.json({
    tenantId: matched.id,
    name: matched.name,
    hasPassword: Boolean(matched.password && matched.password.trim().length > 0),
  });
});

app.post('/api/auth/tenant-login', async (req: Request, res: Response) => {
  if (!supabase) return res.status(500).json({ error: 'Database offline' });
  const { phone, password } = req.body;

  if (!phone || !password) {
    return res.status(400).json({ error: 'Nomor telepon dan password wajib diisi' });
  }

  const cleanPhone = phone.replace(/[^0-9]/g, '');

  const { data: tenants, error } = await supabase
    .from('tenants')
    .select('id, name, phone, email, room_id, status, password, emergency_contact, start_date')
    .eq('status', 'active');

  if (error || !tenants) {
    return res.status(500).json({ error: 'Gagal mengambil data penghuni' });
  }

  const matched = tenants.find((t: any) => {
    const cleanDb = (t.phone || '').replace(/[^0-9]/g, '');
    return cleanDb === cleanPhone || cleanDb.slice(-8) === cleanPhone.slice(-8);
  });

  if (!matched) {
    return res.status(404).json({ error: 'Nomor HP tidak ditemukan dalam daftar penghuni aktif.' });
  }

  // Jika penghuni belum punya password di database, arahkan untuk buat password
  if (!matched.password || matched.password.trim().length === 0) {
    return res.status(403).json({
      error: 'Akun Anda belum memiliki kata sandi. Silakan buat kata sandi terlebih dahulu.',
      requireSetPassword: true,
      tenantId: matched.id,
      name: matched.name,
    });
  }

  if (matched.password !== password) {
    return res.status(401).json({ error: 'Kata sandi / password salah.' });
  }

  // Ambil data kamar jika ada
  let assignedRoom = null;
  if (matched.room_id) {
    const { data: roomData } = await supabase.from('rooms').select('*').eq('id', matched.room_id).maybeSingle();
    assignedRoom = roomData;
  }
  const sessionData = {
    id: matched.id,
    name: matched.name,
    phone: matched.phone,
    email: matched.email,
    roomId: matched.room_id,
    startDate: matched.start_date,
    status: matched.status,
    emergencyContact: matched.emergency_contact,
    roomNumber: assignedRoom?.number || 'Belum Ditentukan',
    roomType: assignedRoom?.type || 'Standard',
    roomFloor: assignedRoom?.floor || 1,
    monthlyPrice: assignedRoom?.monthly_price || 0,
  };

  res.json({
    tenant: sessionData,
    token: `tenant-${matched.id}-${Date.now()}`,
  });
});

app.post('/api/auth/tenant-set-password', async (req: Request, res: Response) => {
  if (!supabase) return res.status(500).json({ error: 'Database offline' });
  const { tenantId, phone, password } = req.body;

  if ((!tenantId && !phone) || !password) {
    return res.status(400).json({ error: 'ID/Nomor telepon dan password baru wajib diisi' });
  }

  if (password.length < 4) {
    return res.status(400).json({ error: 'Password minimal 4 karakter' });
  }

  let targetId = tenantId;
  if (!targetId && phone) {
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    const { data: tenants } = await supabase.from('tenants').select('id, phone').eq('status', 'active');
    const matched = (tenants || []).find((t: any) => {
      const cleanDb = (t.phone || '').replace(/[^0-9]/g, '');
      return cleanDb === cleanPhone || cleanDb.slice(-8) === cleanPhone.slice(-8);
    });
    if (!matched) {
      return res.status(404).json({ error: 'Penghuni tidak ditemukan.' });
    }
    targetId = matched.id;
  }

  const { error } = await supabase
    .from('tenants')
    .update({ password, updated_at: new Date().toISOString() })
    .eq('id', targetId);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  // Ambil data tenant lengkap beserta kamarnya
  const { data: updatedTenant, error: fetchErr } = await supabase
    .from('tenants')
    .select('id, name, phone, email, room_id, status, emergency_contact, start_date')
    .eq('id', targetId)
    .single();

  if (fetchErr || !updatedTenant) {
    return res.status(500).json({ error: 'Gagal memuat profil setelah update password.' });
  }

  let assignedRoom = null;
  if (updatedTenant.room_id) {
    const { data: roomData } = await supabase.from('rooms').select('*').eq('id', updatedTenant.room_id).maybeSingle();
    assignedRoom = roomData;
  }
  const sessionData = {
    id: updatedTenant.id,
    name: updatedTenant.name,
    phone: updatedTenant.phone,
    email: updatedTenant.email,
    roomId: updatedTenant.room_id,
    startDate: updatedTenant.start_date,
    status: updatedTenant.status,
    emergencyContact: updatedTenant.emergency_contact,
    roomNumber: assignedRoom?.number || 'Belum Ditentukan',
    roomType: assignedRoom?.type || 'Standard',
    roomFloor: assignedRoom?.floor || 1,
    monthlyPrice: assignedRoom?.monthly_price || 0,
  };

  res.json({
    success: true,
    message: 'Password berhasil dibuat.',
    tenant: sessionData,
    token: `tenant-${updatedTenant.id}-${Date.now()}`,
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
    hasPassword: Boolean(t.password && t.password.trim().length > 0),
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
  if (b.password !== undefined) updates.password = b.password ? b.password : null;
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

  // AUTO-GENERATE TAGIHAN H-5 JATUH TEMPO
  // Jika penghuni membuka portal / get invoices, otomatis pastikan tagihan bulan ini sudah dibuatkan jika sudah masuk H-5 jatuh tempo
  if (req.query.tenantId) {
    try {
      const tenantId = req.query.tenantId as string;
      const { data: tenant } = await supabase
        .from('tenants')
        .select('*, rooms(id, number, monthly_price)')
        .eq('id', tenantId)
        .eq('status', 'active')
        .maybeSingle();

      if (tenant && tenant.room_id) {
        const { data: sData } = await supabase.from('settings').select('default_due_day').limit(1).maybeSingle();
        let dueDay = sData?.default_due_day || 10;
        if (tenant.start_date) {
          const parts = tenant.start_date.split('-');
          if (parts.length === 3) dueDay = parseInt(parts[2], 10) || dueDay;
        }

        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth() + 1; // 1-12
        const currentPeriod = `${year}-${String(month).padStart(2, '0')}`;
        const maxDays = new Date(year, month, 0).getDate();
        const actualDueDay = Math.min(dueDay, maxDays);
        const dueDate = new Date(year, month - 1, actualDueDay);

        // Hitung selisih hari: jika sekarang >= (dueDate - 5 hari)
        const fiveDaysBeforeDue = new Date(dueDate);
        fiveDaysBeforeDue.setDate(fiveDaysBeforeDue.getDate() - 5);

        if (now >= fiveDaysBeforeDue) {
          // Periksa apakah invoice periode ini sudah ada
          const { data: existingInv } = await supabase
            .from('invoices')
            .select('id')
            .eq('tenant_id', tenantId)
            .eq('period_month', currentPeriod)
            .maybeSingle();

          if (!existingInv) {
            const dueDateStr = `${currentPeriod}-${String(actualDueDay).padStart(2, '0')}`;
            const invNumber = `INV-${currentPeriod.replace('-', '')}-${tenant.phone?.slice(-4) || String(actualDueDay).padStart(2, '0')}`;
            const amount = Number(tenant.rooms?.monthly_price) || 1500000;

            await supabase.from('invoices').insert([
              {
                invoice_number: invNumber,
                tenant_id: tenantId,
                room_id: tenant.room_id,
                period_month: currentPeriod,
                amount,
                due_date: dueDateStr,
                status: 'unpaid',
                notes: 'Otomatis diterbitkan H-5 sebelum jatuh tempo',
              },
            ]);
            console.log(`[Auto-Billing H-5] Berhasil menerbitkan invoice ${invNumber} untuk ${tenant.name}`);
          }
        }
      }
    } catch (autoErr: any) {
      console.warn('[Auto-Billing Warning] Gagal cek H-5:', autoErr.message);
    }
  }

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

  let calculatedDueDate = dueDate;
  if (!calculatedDueDate && tenantId && periodMonth) {
    const { data: tenantData } = await supabase.from('tenants').select('start_date').eq('id', tenantId).maybeSingle();
    let dueDay = 10;
    if (tenantData?.start_date) {
      const parts = tenantData.start_date.split('-');
      if (parts.length === 3) {
        dueDay = parseInt(parts[2], 10) || 10;
      }
    } else {
      const { data: sData } = await supabase.from('settings').select('default_due_day').limit(1).maybeSingle();
      dueDay = sData?.default_due_day || 10;
    }
    const [yearStr, monthStr] = periodMonth.split('-');
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);
    const maxDays = new Date(year, month, 0).getDate();
    const finalDay = Math.min(dueDay, maxDays);
    calculatedDueDate = `${periodMonth}-${String(finalDay).padStart(2, '0')}`;
  }

  const { data, error } = await supabase
    .from('invoices')
    .insert([
      {
        invoice_number: invoiceNumber || `INV-${Date.now().toString().slice(-6)}`,
        tenant_id: tenantId,
        room_id: roomId,
        period_month: periodMonth,
        amount: Number(amount),
        due_date: calculatedDueDate,
        status: 'unpaid',
        notes,
      },
    ])
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// Batch Generate Invoices Otomatis untuk Semua Penghuni Aktif
app.post('/api/invoices/batch-generate', async (req: Request, res: Response) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not connected' });
  const { periodMonth, dueDay } = req.body;

  if (!periodMonth) {
    return res.status(400).json({ error: 'Periode tagihan (YYYY-MM) wajib diisi' });
  }

  // 1. Ambil setting default due day sebagai fallback
  let defaultDueDay = dueDay;
  if (!defaultDueDay) {
    const { data: sData } = await supabase.from('settings').select('default_due_day').limit(1).maybeSingle();
    defaultDueDay = sData?.default_due_day || 10;
  }

  // 2. Ambil seluruh penghuni aktif beserta tanggal mulai sewa (start_date)
  const { data: activeTenants, error: tenantErr } = await supabase
    .from('tenants')
    .select('id, name, room_id, start_date')
    .eq('status', 'active');

  if (tenantErr) return res.status(500).json({ error: tenantErr.message });
  if (!activeTenants || activeTenants.length === 0) {
    return res.json({ count: 0, message: 'Tidak ada penghuni aktif yang perlu ditagih.' });
  }

  // 3. Ambil data kamar untuk harga sewa
  const roomIds = activeTenants.map((t: any) => t.room_id).filter(Boolean);
  const { data: roomList } = await supabase.from('rooms').select('id, monthly_price').in('id', roomIds);
  const roomPriceMap = new Map((roomList || []).map((r: any) => [r.id, Number(r.monthly_price)]));

  // 4. Cek invoice yang SUDAH ada di periode tersebut (mencegah tagihan dobel)
  const { data: existingInvoices } = await supabase
    .from('invoices')
    .select('tenant_id')
    .eq('period_month', periodMonth);

  const existingTenantSet = new Set((existingInvoices || []).map((i: any) => i.tenant_id));

  // 5. Hitung batas hari dalam bulan periode (misal Feb: 28/29, April: 30)
  const [yearStr, monthStr] = periodMonth.split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  const maxDaysInMonth = new Date(year, month, 0).getDate();

  // 6. Susun invoice baru dengan jatuh tempo dinamis mengikuti start_date tiap penghuni
  const newInvoicesToInsert: any[] = [];
  let serial = 1;
  for (const t of activeTenants) {
    if (!existingTenantSet.has(t.id) && t.room_id) {
      const price = roomPriceMap.get(t.room_id) || 1500000;
      const invNum = `INV-${periodMonth.replace('-', '')}-${String(serial).padStart(3, '0')}`;
      serial++;

      let tenantDueDay = defaultDueDay;
      if (t.start_date) {
        const parts = t.start_date.split('-');
        if (parts.length === 3) {
          tenantDueDay = parseInt(parts[2], 10) || defaultDueDay;
        }
      }

      // Pastikan tanggal tidak melebihi jumlah hari di bulan tersebut
      const clampedDueDay = Math.min(tenantDueDay, maxDaysInMonth);
      const dueDate = `${periodMonth}-${String(clampedDueDay).padStart(2, '0')}`;

      newInvoicesToInsert.push({
        invoice_number: invNum,
        tenant_id: t.id,
        room_id: t.room_id,
        period_month: periodMonth,
        amount: price,
        due_date: dueDate,
        status: 'unpaid',
      });
    }
  }

  if (newInvoicesToInsert.length === 0) {
    return res.json({
      count: 0,
      message: `Semua penghuni aktif sudah memiliki tagihan untuk periode ${periodMonth}.`,
    });
  }

  const { error: insertErr } = await supabase.from('invoices').insert(newInvoicesToInsert);
  if (insertErr) return res.status(500).json({ error: insertErr.message });

  res.json({
    count: newInvoicesToInsert.length,
    message: `Berhasil membuat ${newInvoicesToInsert.length} tagihan sewa baru untuk periode ${periodMonth}.`,
  });
});

// HELPER INTI PENGIRIM PENGINGAT JATUH TEMPO (Digunakan endpoint & Cron Job)
async function triggerDueReminders(daysAhead: number): Promise<{ count: number; successCount: number; results: any[] }> {
  if (!supabase) return { count: 0, successCount: 0, results: [] };

  const targetDate = new Date();
  targetDate.setDate(targetDate.getDate() + daysAhead);
  const targetDateStr = targetDate.toISOString().split('T')[0];

  const { data: invoices, error } = await supabase
    .from('invoices')
    .select('*, rooms(number), tenants(name, phone, start_date)')
    .eq('status', 'unpaid')
    .eq('due_date', targetDateStr);

  if (error || !invoices || invoices.length === 0) {
    return { count: 0, successCount: 0, results: [] };
  }

  const { data: settingsData } = await supabase.from('settings').select('kost_name, default_due_day').limit(1).maybeSingle();
  const kostName = settingsData?.kost_name || 'Kost';

  let successCount = 0;
  const results: any[] = [];

  for (const inv of invoices) {
    const tenant = inv.tenants;
    const room = inv.rooms;
    const tenantPhone = tenant?.phone;

    if (!tenantPhone) {
      results.push({ invoiceNumber: inv.invoice_number, status: 'skipped', reason: 'No phone' });
      continue;
    }

    let startDay = settingsData?.default_due_day || 10;
    if (tenant?.start_date) {
      const parts = tenant.start_date.split('-');
      if (parts.length === 3) startDay = parseInt(parts[2], 10) || startDay;
    }

    const periodFormatted = formatRentalPeriod(inv.period_month, startDay);
    const nominalFormatted = new Intl.NumberFormat('id-ID').format(Number(inv.amount));
    const dueFormatted = formatIndoDate(inv.due_date);

    const reminderMsg =
      `Halo Kak *${tenant.name || 'Penghuni'}* 👋\n\n` +
      `Ini adalah pesan pengingat tagihan dari *${kostName}*.\n` +
      `Tagihan sewa kamar *No. ${room?.number || '-'}* periode *${periodFormatted}* sebesar *Rp ${nominalFormatted}* akan jatuh tempo pada *${dueFormatted}* (${daysAhead} hari lagi).\n\n` +
      `Silakan lakukan pembayaran tepat waktu melalui portal penghuni kost atau hubungi pengelola jika ada pertanyaan.\n\n` +
      `Terima kasih 🙏`;

    const sent = await sendWhatsAppMessage({ phone: tenantPhone, message: reminderMsg });
    if (sent) successCount++;

    results.push({
      invoiceNumber: inv.invoice_number,
      tenant: tenant.name,
      phone: tenantPhone,
      status: sent ? 'sent' : 'failed_or_logged',
    });
  }

  return {
    count: invoices.length,
    successCount,
    results,
  };
}

// PENGINGAT TAGIHAN (Dapat dipicu otomatis via cron harian atau tombol admin)
app.post('/api/invoices/send-due-reminders', async (req: Request, res: Response) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not connected' });

  try {
    const days = Number(req.body.daysAhead) || 3;
    const result = await triggerDueReminders(days);

    res.json({
      daysAhead: days,
      totalFound: result.count,
      successCount: result.successCount,
      results: result.results,
    });
  } catch (err: any) {
    console.error('Error saat kirim pengingat tagihan:', err);
    res.status(500).json({ error: err.message });
  }
});

// KIRIM PENGINGAT WA INDIVIDUAL PER INVOICE (Manual Trigger dari Dashboard)
app.post('/api/invoices/:id/send-reminder', async (req: Request, res: Response) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not connected' });

  try {
    const { id } = req.params;
    const { data: inv, error } = await supabase
      .from('invoices')
      .select('*, rooms(number), tenants(name, phone, start_date)')
      .eq('id', id)
      .single();

    if (error || !inv) {
      return res.status(404).json({ error: 'Invoice tidak ditemukan' });
    }

    const tenant = inv.tenants;
    const room = inv.rooms;
    const tenantPhone = tenant?.phone;

    if (!tenantPhone) {
      return res.status(400).json({ error: 'Penghuni tidak memiliki nomor WhatsApp/HP' });
    }

    const { data: settingsData } = await supabase.from('settings').select('kost_name, default_due_day').limit(1).maybeSingle();
    const kostName = settingsData?.kost_name || 'Kost';

    let startDay = settingsData?.default_due_day || 10;
    if (tenant?.start_date) {
      const parts = tenant.start_date.split('-');
      if (parts.length === 3) startDay = parseInt(parts[2], 10) || startDay;
    }

    const periodFormatted = formatRentalPeriod(inv.period_month, startDay);
    const nominalFormatted = new Intl.NumberFormat('id-ID').format(Number(inv.amount));
    const dueFormatted = formatIndoDate(inv.due_date);

    const reminderMsg =
      `Halo Kak *${tenant.name || 'Penghuni'}* 👋\n\n` +
      `Ini adalah pesan pengingat tagihan dari *${kostName}*.\n` +
      `Tagihan sewa kamar *No. ${room?.number || '-'}* periode *${periodFormatted}* sebesar *Rp ${nominalFormatted}* memiliki jatuh tempo pada *${dueFormatted}*.\n\n` +
      `Silakan lakukan pembayaran melalui portal penghuni kost atau hubungi pengelola jika memerlukan bantuan.\n\n` +
      `Terima kasih 🙏`;

    const sent = await sendWhatsAppMessage({ phone: tenantPhone, message: reminderMsg });

    res.json({
      success: true,
      sent,
      message: sent
        ? `Pengingat WhatsApp berhasil dikirim ke ${tenant.name} (${tenantPhone})`
        : `Pengingat dicatat di sistem (bot WA offline / tersimpan di log)`,
    });
  } catch (err: any) {
    console.error('Error saat kirim pengingat per invoice:', err);
    res.status(500).json({ error: err.message });
  }
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
        
        // Cari tagihan yang belum dibayar untuk tenant ini
        const currentPeriod = new Date().toISOString().slice(0, 7); // e.g. "2026-11"
        let { data: currentInvoice } = await supabase
          .from('invoices')
          .select('*')
          .eq('tenant_id', tenant.id)
          .eq('status', 'unpaid')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        // Jika tidak ada tagihan unpaid, cari yang bulan berjalan
        if (!currentInvoice) {
          const { data: monthInv } = await supabase
            .from('invoices')
            .select('*')
            .eq('tenant_id', tenant.id)
            .eq('period_month', currentPeriod)
            .maybeSingle();
          currentInvoice = monthInv;
        }

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
          grossAmount = Number(currentInvoice.amount) || grossAmount;
        } else {
          orderId = `INV-${Date.now().toString().slice(-6)}`;
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
 * Helper terpusat untuk memproses pelunasan invoice & mengirimkan kwitansi WA
 */
async function processSuccessfulPayment(invoice: any, paymentDetails: {
  grossAmount: number;
  paymentType: string;
  transactionId: string;
  orderId: string;
  source: string;
}) {
  if (!supabase || invoice.status === 'paid') return;

  const { grossAmount, paymentType, transactionId, orderId, source } = paymentDetails;

  // 1. Simpan bukti submission
  const { data: sub } = await supabase
    .from('payment_submissions')
    .upsert(
      [
        {
          invoice_id: invoice.id,
          tenant_id: invoice.tenant_id,
          amount: Number(grossAmount),
          payment_date: new Date().toISOString().split('T')[0],
          method: paymentType === 'qris' ? 'midtrans_qris' : 'midtrans_va',
          payment_gateway: 'midtrans',
          midtrans_transaction_id: transactionId,
          midtrans_order_id: orderId,
          midtrans_payment_type: paymentType,
          status: 'settlement',
          notes: `Auto-verified via ${source} (${paymentType})`,
        },
      ],
      { onConflict: 'midtrans_transaction_id' }
    )
    .select()
    .single();

  // 2. Update status invoice ke 'paid'
  await supabase
    .from('invoices')
    .update({
      status: 'paid',
      paid_at: new Date().toISOString(),
      latest_submission_id: sub?.id || null,
    })
    .eq('id', invoice.id);

  console.log(`✅ Invoice ${invoice.invoice_number} successfully verified LUNAS via ${source}!`);

  // 3. Kirim notifikasi WA & Resi Kwitansi via Fonnte
  try {
    const { data: tenantData } = await supabase
      .from('tenants')
      .select('name, phone, room_id, start_date')
      .eq('id', invoice.tenant_id)
      .maybeSingle();

    const { data: roomData } = invoice.room_id
      ? await supabase.from('rooms').select('number').eq('id', invoice.room_id).maybeSingle()
      : { data: null };

    const { data: settingsData } = await supabase.from('settings').select('kost_name, phone, default_due_day').limit(1).maybeSingle();
    const kostName = settingsData?.kost_name || 'Kost Management';
    const adminPhone = settingsData?.phone || process.env.ADMIN_WHATSAPP_NUMBER || '';

    const tenantName = tenantData?.name || 'Penghuni Kost';
    const tenantPhone = tenantData?.phone || '';
    const roomNumber = roomData?.number ? `No. ${roomData.number}` : '-';

    let startDay = settingsData?.default_due_day || 10;
    if (tenantData?.start_date) {
      const parts = tenantData.start_date.split('-');
      if (parts.length === 3) startDay = parseInt(parts[2], 10) || startDay;
    }

    const periodFormatted = formatRentalPeriod(invoice.period_month, startDay);
    const nominalFormatted = new Intl.NumberFormat('id-ID').format(Number(grossAmount));
    const paymentDateStr = formatIndoDate(new Date().toISOString());

    // Generate Resi Gambar LUNAS
    let receiptImageBase64 = '';
    try {
      receiptImageBase64 = await generateReceiptImageBase64({
        kostName,
        invoiceNumber: invoice.invoice_number,
        tenantName,
        roomNumber,
        rentalPeriod: periodFormatted,
        amount: Number(grossAmount),
        paymentMethod: `Midtrans (${paymentType.toUpperCase()})`,
        paymentDate: paymentDateStr,
        transactionId: transactionId || orderId,
      });
    } catch (imgErr: any) {
      console.warn('[Receipt Image Warning] Gagal render gambar resi:', imgErr.message);
    }

    // A. Kirim ke WhatsApp Admin/Owner
    if (adminPhone) {
      const adminMsg = `*PEMBAYARAN KOST DITERIMA* 💰\n\n` +
        `• Dari: *${tenantName}*\n` +
        `• Kamar: *${roomNumber}*\n` +
        `• Periode Sewa: *${periodFormatted}*\n` +
        `• Nominal: *Rp ${nominalFormatted}*\n` +
        `• Metode: *Midtrans (${paymentType.toUpperCase()})*\n` +
        `• Waktu: *${new Date().toLocaleString('id-ID')}*\n\n` +
        `Status tagihan otomatis diverifikasi *LUNAS*. Bukti resi terlampir di atas.`;

      await sendWhatsAppMessage({
        phone: adminPhone,
        message: adminMsg,
        imageBase64: receiptImageBase64,
        imageFileName: `Resi_${invoice.invoice_number}.png`,
      });
    }

    // B. Kirim ke WhatsApp Penyewa
    if (tenantPhone) {
      const tenantMsg = `Halo Kak *${tenantName}* 👋\n\n` +
        `Pembayaran sewa kamar *${roomNumber}* periode *${periodFormatted}* sebesar *Rp ${nominalFormatted}* telah *KAMI TERIMA & DIVERIFIKASI LUNAS* ✅\n\n` +
        `Bukti resi kwitansi digital Anda terlampir pada gambar di atas.\n` +
        `Terima kasih telah melakukan pembayaran tepat waktu! 🙏`;

      await sendWhatsAppMessage({
        phone: tenantPhone,
        message: tenantMsg,
        imageBase64: receiptImageBase64,
        imageFileName: `Kwitansi_${invoice.invoice_number}.png`,
      });
    }
  } catch (waErr: any) {
    console.error('Gagal mengirim notifikasi WA:', waErr.message);
  }
}

/**
 * 4. CHECK TRANSACTION STATUS (Real-time check)
 */
app.get('/api/payments/midtrans/status/:orderId', async (req: Request, res: Response) => {
  if (!isMidtransConfigured || !coreApi) {
    return res.status(503).json({ error: 'Midtrans belum dikonfigurasi' });
  }

  try {
    let status: any;
    try {
      status = await coreApi.transaction.status(req.params.orderId);
    } catch (statusErr: any) {
      // Jika Midtrans mengembalikan 404 (transaksi belum terbentuk), jangan crash 500
      return res.status(200).json({
        transaction_status: 'pending',
        message: 'Transaksi belum diselesaikan atau sedang diproses.',
      });
    }

    // Sinkronkan langsung ke database jika statusnya settlement atau capture
    if (supabase && (status.transaction_status === 'settlement' || status.transaction_status === 'capture')) {
      const baseInvNumber = req.params.orderId.split('-').slice(0, 3).join('-');
      const { data: invoice } = await supabase
        .from('invoices')
        .select('*')
        .or(`invoice_number.eq.${baseInvNumber},invoice_number.eq.${req.params.orderId}`)
        .maybeSingle();

      if (invoice && invoice.status !== 'paid') {
        await processSuccessfulPayment(invoice, {
          grossAmount: Number(status.gross_amount),
          paymentType: status.payment_type || 'midtrans',
          transactionId: status.transaction_id,
          orderId: req.params.orderId,
          source: 'polling',
        });
      }
    }

    res.json(status);
  } catch (err: any) {
    console.error('Status check error:', err.message);
    res.status(200).json({ transaction_status: 'pending' });
  }
});

/**
 * 5. MIDTRANS WEBHOOK NOTIFICATION (Always returns HTTP 200 OK)
 */
app.post('/api/payments/midtrans/notification', async (req: Request, res: Response) => {
  const notification = req.body;
  if (!supabase) return res.status(200).json({ status: 'ok', note: 'db offline' });

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

  // Verifikasi signature
  const isValid = verifyMidtransSignature(order_id, status_code, gross_amount, signature_key);
  if (!isValid) {
    console.warn(`🚨 Invalid Midtrans Signature for order: ${order_id}`);
    // Tetap kembalikan 200 agar Midtrans tidak retry terus-menerus
    return res.status(200).json({ status: 'rejected', error: 'Invalid signature key' });
  }

  try {
    const { data: matchedInvoices } = await supabase.from('invoices').select('*');
    const invoice = (matchedInvoices || []).find((inv: any) =>
      inv.invoice_number === order_id || order_id.startsWith(inv.invoice_number)
    );

    if (!invoice) {
      console.warn(`Invoice not found for order ${order_id}`);
      return res.status(200).json({ status: 'ok', note: 'Invoice not found' });
    }

    const isSuccess =
      transaction_status === 'settlement' ||
      (transaction_status === 'capture' && fraud_status === 'accept');

    if (isSuccess && invoice.status !== 'paid') {
      await processSuccessfulPayment(invoice, {
        grossAmount: Number(gross_amount),
        paymentType: payment_type || 'qris',
        transactionId: transaction_id,
        orderId: order_id,
        source: 'webhook',
      });
    }

    return res.status(200).json({ status: 'ok' });
  } catch (err: any) {
    console.error('Error handling Midtrans webhook:', err);
    return res.status(200).json({ status: 'ok', error: err.message });
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

// Export app instance untuk Vercel Serverless / Testing
export default app;

// Jalankan server jika dijalankan secara mandiri (local / container), bukan di-import oleh serverless handler
if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`🚀 Kost Backend API running on http://localhost:${PORT}`);
    console.log(`📡 Database mode: ${isSupabaseConfigured ? 'Supabase Live' : 'Offline / Mock'}`);
    console.log(`💳 Midtrans Gateway: ${isMidtransConfigured ? 'Configured & Active' : 'Waiting for Keys'}`);

    // CRON JOB: Otomatis jalankan pengingat setiap pukul 09:00 pagi WIB (Asia/Jakarta)
    // Menargetkan tagihan jatuh tempo H-3 dan H-2
    cron.schedule('0 9 * * *', async () => {
      console.log('[Cron Job] Menjalankan pengingat otomatis jatuh tempo tagihan H-3 & H-2...');
      try {
        const h3 = await triggerDueReminders(3);
        const h2 = await triggerDueReminders(2);
        console.log(`[Cron Job Selesai] H-3: ${h3.successCount}/${h3.count} terkirim. H-2: ${h2.successCount}/${h2.count} terkirim.`);
      } catch (e: any) {
        console.error('[Cron Job Error] Gagal menjalankan pengingat otomatis:', e.message);
      }
    }, {
      timezone: 'Asia/Jakarta',
    });
    console.log('⏰ Cron Job aktif: Pengingat tagihan H-3 & H-2 dijadwalkan setiap 09:00 WIB');
  });
}
