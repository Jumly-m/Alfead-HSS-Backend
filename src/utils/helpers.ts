export const formatTZS = (amount: number): string => {
  return `TZS ${amount.toLocaleString('en-TZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

export const formatPhone = (phone: string): string => {
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('0')) {
    return `+255${cleaned.slice(1)}`;
  }
  if (cleaned.startsWith('255')) {
    return `+${cleaned}`;
  }
  return phone;
};

export const formatPhone255 = (phone: string): string => {
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('0') && cleaned.length >= 10) {
    return `255${cleaned.slice(1)}`;
  }
  if (cleaned.startsWith('255') && cleaned.length >= 12) {
    return cleaned;
  }
  if (cleaned.startsWith('+255')) {
    return cleaned.slice(1);
  }
  return cleaned;
};

export const validatePhone = (phone: string): boolean => {
  const tzPhoneRegex = /^(\+255|0)[1-9]\d{8}$/;
  return tzPhoneRegex.test(phone);
};

export const validateEmail = (email: string): boolean => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

export const generateSKU = (shopId: string, counter: number): string => {
  // Remove hyphens and take first 8 chars
  const cleanShopId = shopId.replace(/-/g, '').slice(0, 8).toUpperCase();
  return `SKU-${cleanShopId}-${String(counter).padStart(6, '0')}`;
};

export const generateBarcode = (): string => {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `DUKA-${timestamp}${random}`;
};

export const generateOfflineId = (prefix: string = 'OFF'): string => {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 9);
  return `${prefix}-${timestamp}-${random}`;
};
