import express, { Request, Response } from 'express';
import cors from 'cors';
import { supabase, isSupabaseConfigured } from './supabase.js';
import { snap, isMidtransConfigured, verifyMidtransSignature } from './midtrans.js';
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

  const { invoiceId } = req.body;
  if (!invoiceId) return res.status(400).json({ error: 'invoiceId is required' });

  try {
    const { data: invoice, error: invErr } = await supabase
      .from('invoices')
      .select('*, tenants(name, email, phone), rooms(number)')
      .eq('id', invoiceId)
      .single();

    if (invErr || !invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.status === 'paid') {
      return res.status(400).json({ error: 'Tagihan sudah lunas' });
    }

    const tenant = invoice.tenants;
    const room = invoice.rooms;

    const parameter = {
      transaction_details: {
        order_id: `${invoice.invoice_number}-${Date.now().toString().slice(-4)}`,
        gross_amount: Math.round(Number(invoice.amount)),
      },
      customer_details: {
        first_name: tenant?.name || 'Penghuni',
        email: tenant?.email || 'penghuni@kost.com',
        phone: tenant?.phone || '08123456789',
      },
      item_details: [
        {
          id: invoice.id,
          price: Math.round(Number(invoice.amount)),
          quantity: 1,
          name: `Sewa Kamar ${room?.number || ''} (${invoice.period_month})`,
        },
      ],
    };

    const transaction = await snap.createTransaction(parameter);

    await supabase
      .from('invoices')
      .update({
        snap_token: transaction.token,
        snap_redirect_url: transaction.redirect_url,
      })
      .eq('id', invoiceId);

    res.json({
      token: transaction.token,
      redirect_url: transaction.redirect_url,
    });
  } catch (err: any) {
    console.error('Midtrans Snap Error:', err);
    res.status(500).json({ error: err.message || 'Gagal membuat transaksi Midtrans' });
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
