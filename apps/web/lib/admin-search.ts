const SAFE_ADMIN_GUEST_PASS_SEARCH = /^[A-Za-z0-9@._+\-\s]+$/;
const MAX_ADMIN_GUEST_PASS_SEARCH_LENGTH = 100;

export function normalizeAdminGuestPassSearch(input?: string | null): string | null {
  const value = input?.trim();
  if (!value) return null;
  if (value.length > MAX_ADMIN_GUEST_PASS_SEARCH_LENGTH) return null;
  return SAFE_ADMIN_GUEST_PASS_SEARCH.test(value) ? value : null;
}
