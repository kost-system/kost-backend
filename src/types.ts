export type UserRole = 'owner' | 'manager' | 'tenant';

export interface User {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: UserRole;
  tenantId?: string;
  avatar?: string;
}

export type RoomStatus = 'available' | 'occupied' | 'maintenance';

export interface Room {
  id: string;
  number: string;
  floor: number;
  type: string;
  monthlyPrice: number;
  status: RoomStatus;
  currentTenantId?: string | null;
  notes?: string;
}

export type TenantStatus = 'active' | 'inactive';

export interface Tenant {
  id: string;
  name: string;
  phone: string;
  email: string;
  roomId: string;
  startDate: string;
  status: TenantStatus;
  notes?: string;
  emergencyContact?: string;
}

export type InvoiceStatus = 'unpaid' | 'pending_verification' | 'paid' | 'overdue' | 'rejected';

export type PaymentMethod = 'bank_transfer' | 'qris';

export type VerificationStatus = 'pending' | 'verified' | 'rejected';

export interface PaymentSubmission {
  id: string;
  invoiceId: string;
  tenantId: string;
  amount: number;
  paymentDate: string;
  method: PaymentMethod;
  senderBank?: string;
  senderName?: string;
  proofImageUrl: string;
  submittedAt: string;
  status: VerificationStatus;
  reviewedBy?: string;
  reviewedAt?: string;
  rejectionReason?: string;
  notes?: string;
}

export interface Invoice {
  id: string;
  invoiceNumber: string;
  tenantId: string;
  roomId: string;
  periodMonth: string;
  amount: number;
  dueDate: string;
  status: InvoiceStatus;
  createdAt: string;
  paidAt?: string;
  latestSubmissionId?: string;
  notes?: string;
}

export type ExpenseCategory = 
  | 'maintenance' 
  | 'utilities' 
  | 'cleaning' 
  | 'security' 
  | 'operational';

export interface Expense {
  id: string;
  description: string;
  amount: number;
  date: string;
  category: ExpenseCategory;
  notes?: string;
  recordedBy: string;
}

export interface KostSettings {
  kostName: string;
  tagline: string;
  address: string;
  phone: string;
  email: string;
  bankName: string;
  bankAccountNumber: string;
  bankAccountName: string;
  qrisNmid: string;
  qrisMerchantName: string;
  qrisImageUrl: string;
  defaultDueDay: number;
  paymentInstructions: string;
}
