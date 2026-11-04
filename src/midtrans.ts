// @ts-ignore
import midtransClient from 'midtrans-client';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

const serverKey = process.env.MIDTRANS_SERVER_KEY || '';
const clientKey = process.env.MIDTRANS_CLIENT_KEY || '';
const isProduction = process.env.MIDTRANS_IS_PRODUCTION === 'true';

export const isMidtransConfigured = Boolean(
  serverKey &&
    !serverKey.includes('your-midtrans') &&
    clientKey &&
    !clientKey.includes('your-midtrans')
);

export const snap = isMidtransConfigured
  ? new midtransClient.Snap({
      isProduction,
      serverKey,
      clientKey,
    })
  : null;

export const coreApi = isMidtransConfigured
  ? new midtransClient.CoreApi({
      isProduction,
      serverKey,
      clientKey,
    })
  : null;

/**
 * Validasi signature SHA512 dari Webhook Notification Midtrans
 * Format: SHA512(order_id + status_code + gross_amount + ServerKey)
 */
export function verifyMidtransSignature(
  orderId: string,
  statusCode: string,
  grossAmount: string,
  signatureKey: string
): boolean {
  if (!serverKey) return false;
  const hash = crypto
    .createHash('sha512')
    .update(`${orderId}${statusCode}${grossAmount}${serverKey}`)
    .digest('hex');
  return hash === signatureKey;
}
