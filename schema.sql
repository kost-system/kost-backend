-- ==============================================================================
-- KOST SYSTEM DATABASE SCHEMA (SUPABASE / POSTGRESQL) - MIDTRANS READY
-- ==============================================================================

-- 1. Enable UUID Extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. ENUM TYPES
DO $$ BEGIN
    CREATE TYPE user_role AS ENUM ('owner', 'manager', 'tenant');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE room_status AS ENUM ('available', 'occupied', 'maintenance');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE tenant_status AS ENUM ('active', 'inactive');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE invoice_status AS ENUM ('unpaid', 'pending_verification', 'paid', 'overdue', 'rejected', 'expired');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE payment_method AS ENUM ('bank_transfer', 'qris', 'midtrans_va', 'midtrans_qris', 'midtrans_ewallet', 'cash');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE verification_status AS ENUM ('pending', 'verified', 'rejected', 'settlement', 'expire', 'deny', 'cancel');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE expense_category AS ENUM ('maintenance', 'utilities', 'cleaning', 'security', 'operational');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 3. USERS TABLE
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255),
    phone VARCHAR(50),
    role user_role NOT NULL DEFAULT 'tenant',
    tenant_id UUID,
    avatar TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. ROOMS TABLE
CREATE TABLE IF NOT EXISTS rooms (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    number VARCHAR(50) UNIQUE NOT NULL,
    floor INT NOT NULL DEFAULT 1,
    type VARCHAR(100) NOT NULL,
    monthly_price NUMERIC(12, 2) NOT NULL,
    status room_status NOT NULL DEFAULT 'available',
    current_tenant_id UUID,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. TENANTS TABLE
CREATE TABLE IF NOT EXISTS tenants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(50) NOT NULL,
    email VARCHAR(255) NOT NULL,
    room_id UUID REFERENCES rooms(id) ON DELETE SET NULL,
    start_date DATE NOT NULL DEFAULT CURRENT_DATE,
    status tenant_status NOT NULL DEFAULT 'active',
    emergency_contact VARCHAR(100),
    password VARCHAR(255),
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Migrasi jika kolom password belum ada di tabel tenants
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS password VARCHAR(255);

-- Foreign keys
DO $$ BEGIN
    ALTER TABLE users ADD CONSTRAINT fk_user_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE rooms ADD CONSTRAINT fk_room_tenant FOREIGN KEY (current_tenant_id) REFERENCES tenants(id) ON DELETE SET NULL;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 6. INVOICES TABLE
CREATE TABLE IF NOT EXISTS invoices (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    invoice_number VARCHAR(100) UNIQUE NOT NULL,
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    period_month VARCHAR(7) NOT NULL, -- Format: YYYY-MM
    amount NUMERIC(12, 2) NOT NULL,
    due_date DATE NOT NULL,
    status invoice_status NOT NULL DEFAULT 'unpaid',
    latest_submission_id UUID,
    snap_token VARCHAR(255),
    snap_redirect_url TEXT,
    paid_at TIMESTAMPTZ,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. PAYMENT SUBMISSIONS / TRANSACTIONS TABLE (MIDTRANS IDEMPOTENCY READY)
CREATE TABLE IF NOT EXISTS payment_submissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    amount NUMERIC(12, 2) NOT NULL,
    payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
    method payment_method NOT NULL DEFAULT 'bank_transfer',
    payment_gateway VARCHAR(50) NOT NULL DEFAULT 'manual', -- 'manual' | 'midtrans'
    midtrans_transaction_id VARCHAR(255) UNIQUE, -- Idempotency key: prevents duplicate transaction processing
    midtrans_order_id VARCHAR(255),
    midtrans_payment_type VARCHAR(100),
    sender_bank VARCHAR(100),
    sender_name VARCHAR(255),
    proof_image_url TEXT, -- NULLABLE for automated payment gateways
    status verification_status NOT NULL DEFAULT 'pending',
    reviewed_by VARCHAR(255),
    reviewed_at TIMESTAMPTZ,
    rejection_reason TEXT,
    raw_response JSONB, -- Stores webhook payload for audit and dispute tracing
    notes TEXT,
    submitted_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

DO $$ BEGIN
    ALTER TABLE invoices ADD CONSTRAINT fk_invoice_latest_submission FOREIGN KEY (latest_submission_id) REFERENCES payment_submissions(id) ON DELETE SET NULL;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 8. EXPENSES TABLE
CREATE TABLE IF NOT EXISTS expenses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    description VARCHAR(255) NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    category expense_category NOT NULL DEFAULT 'operational',
    recorded_by VARCHAR(255) NOT NULL,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 9. SETTINGS TABLE
CREATE TABLE IF NOT EXISTS settings (
    id INT PRIMARY KEY DEFAULT 1,
    kost_name VARCHAR(255) NOT NULL DEFAULT 'KostFlow Residence',
    tagline VARCHAR(255) DEFAULT '',
    address TEXT DEFAULT '',
    phone VARCHAR(50) DEFAULT '',
    email VARCHAR(255) DEFAULT '',
    bank_name VARCHAR(100) DEFAULT '',
    bank_account_number VARCHAR(100) DEFAULT '',
    bank_account_name VARCHAR(255) DEFAULT '',
    qris_nmid VARCHAR(100) DEFAULT '',
    qris_merchant_name VARCHAR(255) DEFAULT '',
    qris_image_url TEXT DEFAULT '',
    midtrans_server_key TEXT DEFAULT '',
    midtrans_client_key TEXT DEFAULT '',
    midtrans_is_production BOOLEAN DEFAULT false,
    default_due_day INT DEFAULT 10,
    payment_instructions TEXT DEFAULT '',
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT single_row_check CHECK (id = 1)
);

-- 10. INDEXES
CREATE INDEX IF NOT EXISTS idx_rooms_status ON rooms(status);
CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);
CREATE INDEX IF NOT EXISTS idx_tenants_room_id ON tenants(room_id);
CREATE INDEX IF NOT EXISTS idx_invoices_period_month ON invoices(period_month);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_tenant_id ON invoices(tenant_id);
CREATE INDEX IF NOT EXISTS idx_submissions_invoice_id ON payment_submissions(invoice_id);
CREATE INDEX IF NOT EXISTS idx_submissions_midtrans_id ON payment_submissions(midtrans_transaction_id);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON payment_submissions(status);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);

-- 11. ROW LEVEL SECURITY
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;

-- 12. RLS POLICIES
DO $$ BEGIN
    CREATE POLICY "Public read rooms" ON rooms FOR SELECT USING (true);
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE POLICY "Public read settings" ON settings FOR SELECT USING (true);
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE POLICY "Service role full access users" ON users FOR ALL USING (true);
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE POLICY "Service role full access rooms" ON rooms FOR ALL USING (true);
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE POLICY "Service role full access tenants" ON tenants FOR ALL USING (true);
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE POLICY "Service role full access invoices" ON invoices FOR ALL USING (true);
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE POLICY "Service role full access submissions" ON payment_submissions FOR ALL USING (true);
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE POLICY "Service role full access expenses" ON expenses FOR ALL USING (true);
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE POLICY "Service role full access settings" ON settings FOR ALL USING (true);
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ==============================================================================
-- 9. ADMIN MIGRATION: ADD PASSWORD COLUMN & SEED SUPERADMIN/OWNER
-- ==============================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS password VARCHAR(255);

-- Tambahkan user default Owner jika belum ada
INSERT INTO users (name, email, password, phone, role)
VALUES ('Super Admin / Owner', 'owner@kost.com', 'admin123', '081234567890', 'owner')
ON CONFLICT (email) DO UPDATE 
SET password = EXCLUDED.password, role = 'owner';
