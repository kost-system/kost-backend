import dotenv from 'dotenv';

dotenv.config();

export interface SendWhatsAppParams {
  phone: string;
  message: string;
}

const WA_BOT_URL = process.env.WA_BOT_URL || 'http://localhost:5001';
const WA_BOT_SECRET = process.env.WA_BOT_SECRET || 'kost_secret_wa_bot_key_2026';
const WA_GATEWAY_TOKEN = process.env.WA_GATEWAY_TOKEN || ''; // Fonnte token jika ada

/**
 * Helper fleksibel untuk mengirim WhatsApp
 * Mendukung:
 * 1. Bot Baileys/WhatsApp-Web internal (POST ke WA_BOT_URL)
 * 2. Gateway Fonnte jika WA_GATEWAY_TOKEN diisi
 * 3. Fallback console log jika bot sedang offline (mencegah server crash)
 */
export async function sendWhatsAppMessage({ phone, message }: SendWhatsAppParams): Promise<boolean> {
  if (!phone || !message) return false;

  const cleanedPhone = phone.replace(/[^0-9]/g, '');
  if (!cleanedPhone) return false;

  // 1. Jika pengguna mengatur Fonnte Token di .env
  if (WA_GATEWAY_TOKEN) {
    try {
      const response = await fetch('https://api.fonnte.com/send', {
        method: 'POST',
        headers: {
          Authorization: WA_GATEWAY_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          target: cleanedPhone,
          message: message,
        }),
      });
      const data = await response.json();
      console.log(`[Fonnte WA] Kirim ke ${cleanedPhone}:`, data);
      return Boolean(data?.status);
    } catch (err: any) {
      console.error(`[Fonnte Error] Gagal kirim ke ${cleanedPhone}:`, err.message);
    }
  }

  // 2. Kirim via Microservice Bot WhatsApp internal
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(`${WA_BOT_URL}/send-message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WA_BOT_SECRET}`,
      },
      body: JSON.stringify({ phone: cleanedPhone, message }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (response.ok) {
      console.log(`[WA Bot] Pesan berhasil dikirim ke ${cleanedPhone}`);
      return true;
    } else {
      const errData: any = await response.json().catch(() => ({}));
      console.warn(`[WA Bot Warning] Gagal kirim ke ${cleanedPhone}:`, errData?.error || response.statusText);
      return false;
    }
  } catch (err: any) {
    console.warn(`[WA Bot Offline] Tidak dapat terhubung ke bot di ${WA_BOT_URL} (${err.message}). Pesan dicatat di log:`);
    console.log(`--- DRAFT PESAN KE ${cleanedPhone} --- \n${message}\n----------------------------------`);
    return false;
  }
}

/**
 * Format tanggal Indonesia: 15 Januari 2026
 */
export function formatIndoDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const months = [
      'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
      'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
    ];
    return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
  } catch {
    return dateStr;
  }
}

/**
 * Format rentang periode sewa: misal 15 Januari - 15 Februari 2026
 */
export function formatRentalPeriod(periodMonth: string, startDay = 10): string {
  try {
    const [yearStr, monthStr] = periodMonth.split('-');
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10); // 1-12

    const months = [
      'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
      'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
    ];

    const currentMonthName = months[month - 1];
    
    // Bulan berikutnya
    let nextMonth = month + 1;
    let nextYear = year;
    if (nextMonth > 12) {
      nextMonth = 1;
      nextYear += 1;
    }
    const nextMonthName = months[nextMonth - 1];

    if (year === nextYear) {
      return `${startDay} ${currentMonthName} - ${startDay} ${nextMonthName} ${year}`;
    }
    return `${startDay} ${currentMonthName} ${year} - ${startDay} ${nextMonthName} ${nextYear}`;
  } catch {
    return periodMonth;
  }
}
