# Kost Backend API

Pusat logika bisnis, transaksi, dan layanan data untuk sistem manajemen kos (Kost System). Melayani permintaan data dari **Kost Dashboard** (admin) dan **Kost Landing Page** (publik/penyewa).

## 🚀 Fitur Utama
- **RESTful Architecture**: Endpoint bersih dan modular.
- **Logika Bisnis Terpusat**:
  - Manajemen Kamar (CRUD & status ketersediaan)
  - Manajemen Penghuni (Pendaftaran, mutasi, check-out)
  - Tagihan & Faktur (Pembuatan tagihan satuan dan batch bulanan)
  - Verifikasi Pembayaran (Pengajuan bukti transfer, approval/rejection)
  - Pencatatan Pengeluaran Operasional
  - Pengaturan Kost & Metode Pembayaran (QRIS, Transfer Bank)
- **Database Ready**: Konfigurasi awal menggunakan penyimpanan terstruktur yang bersih tanpa mock/fake data, siap disambungkan ke PostgreSQL, MySQL, Supabase, atau Prisma ORM.

## 🛠️ Tech Stack
- **Runtime**: Node.js
- **Framework**: Express.js
- **Bahasa**: TypeScript
- **Tooling**: `tsx` (live reload development)

## 📦 Menjalankan Proyek

### 1. Instalasi Dependensi
```bash
npm install
```

### 2. Jalankan Server Development
```bash
npm run dev
```
Server akan berjalan di: `http://localhost:5000`

### 3. Build & Production
```bash
npm run build
npm start
```

## 🔌 API Endpoints
- `GET /api/health` - Health check status backend
- `GET /api/bootstrap` - Mengambil seluruh data koleksi
- `GET, POST, PUT, DELETE /api/rooms` - Manajemen kamar kos
- `GET, POST, PUT, DELETE /api/tenants` - Manajemen penyewa
- `POST /api/tenants/:id/checkout` - Check out penyewa & bebaskan kamar
- `GET, POST, PUT, DELETE /api/invoices` - Tagihan sewa
- `POST /api/invoices/batch-generate` - Generate tagihan massal bulanan
- `GET, POST /api/submissions` - Pengajuan bukti pembayaran
- `POST /api/submissions/:id/verify` - Verifikasi pembayaran
- `POST /api/submissions/:id/reject` - Penolakan pembayaran
- `GET, POST, PUT, DELETE /api/expenses` - Pengeluaran operasional
- `GET, PUT /api/settings` - Pengaturan profil kos & rekening
