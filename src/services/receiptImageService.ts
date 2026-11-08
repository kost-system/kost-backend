import * as PImage from 'pureimage';
import { Writable } from 'stream';

export interface ReceiptData {
  kostName: string;
  invoiceNumber: string;
  tenantName: string;
  roomNumber: string;
  rentalPeriod: string;
  amount: number;
  paymentMethod: string;
  paymentDate: string;
  transactionId: string;
}

/**
 * Merender kwitansi invoice digital lunas menjadi Base64 PNG buffer
 */
export async function generateReceiptImageBase64(data: ReceiptData): Promise<string> {
  const width = 650;
  const height = 820;
  const img = PImage.make(width, height);
  const ctx = img.getContext('2d');

  // Background
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, width, height);

  // Card putih tengah
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(30, 30, width - 60, height - 60);

  // Header banner atas (Hijau Emerald Mewah)
  ctx.fillStyle = '#059669';
  ctx.fillRect(30, 30, width - 60, 110);

  // Judul Header
  ctx.fillStyle = '#ffffff';
  ctx.font = '24pt sans-serif';
  ctx.fillText(data.kostName.toUpperCase(), 50, 75);

  ctx.font = '13pt sans-serif';
  ctx.fillText('BUKTI RESI PEMBAYARAN KOST RESMI', 50, 110);

  // Status Badge "LUNAS" (Hijau)
  ctx.fillStyle = '#10b981';
  ctx.fillRect(width - 180, 55, 120, 42);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 15pt sans-serif';
  ctx.fillText('✓ LUNAS', width - 165, 84);

  // Garis pemisah abu-abu
  ctx.fillStyle = '#e2e8f0';
  ctx.fillRect(50, 160, width - 100, 2);

  // Baris Info Transaksi
  let y = 195;
  const lineHeight = 38;

  function drawRow(label: string, val: string, isHighlight = false) {
    ctx.fillStyle = '#64748b';
    ctx.font = '12pt sans-serif';
    ctx.fillText(label, 50, y);

    ctx.fillStyle = isHighlight ? '#0f172a' : '#1e293b';
    ctx.font = isHighlight ? 'bold 14pt sans-serif' : '13pt sans-serif';
    ctx.fillText(val, 240, y);

    y += lineHeight;
  }

  drawRow('No. Invoice', `: ${data.invoiceNumber}`, true);
  drawRow('Nama Penyewa', `: ${data.tenantName}`);
  drawRow('Nomor Kamar', `: ${data.roomNumber}`);
  drawRow('Periode Sewa', `: ${data.rentalPeriod}`);
  drawRow('Tanggal Bayar', `: ${data.paymentDate}`);
  drawRow('Metode Bayar', `: ${data.paymentMethod}`);
  drawRow('ID Transaksi', `: ${data.transactionId}`);

  // Kotak Nominal Total
  y += 10;
  ctx.fillStyle = '#f0fdf4';
  ctx.fillRect(50, y, width - 100, 90);

  ctx.fillStyle = '#166534';
  ctx.font = '12pt sans-serif';
  ctx.fillText('TOTAL PEMBAYARAN DITERIMA', 70, y + 32);

  const nominalStr = `Rp ${new Intl.NumberFormat('id-ID').format(data.amount)}`;
  ctx.fillStyle = '#059669';
  ctx.font = 'bold 26pt sans-serif';
  ctx.fillText(nominalStr, 70, y + 72);

  // Footer / Catatan Sah
  y += 125;
  ctx.fillStyle = '#94a3b8';
  ctx.font = '10pt sans-serif';
  ctx.fillText('• Struk digital ini dikeluarkan secara otomatis oleh sistem manajemen kost.', 50, y);
  ctx.fillText('• Pembayaran telah diverifikasi secara realtime melalui Midtrans Payment Gateway.', 50, y + 20);
  ctx.fillText('• Harap simpan bukti pembayaran ini sebagai tanda terima yang sah.', 50, y + 40);

  // Stream ke Base64
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });

    PImage.encodePNGToStream(img, stream)
      .then(() => {
        const fullBuffer = Buffer.concat(chunks);
        resolve(fullBuffer.toString('base64'));
      })
      .catch(reject);
  });
}
