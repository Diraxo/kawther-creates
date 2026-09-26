// Password policy for the "change password" form (pure). Same minimum as signup (8 characters).
export const MIN_PASSWORD_LENGTH = 8;

/**
 * @returns {{ current?: string, next?: string, confirm?: string }} field -> inline error (empty object = valid)
 */
export function validatePasswordChange({ current, next, confirm }) {
  const errors = {};
  if (!current) errors.current = 'Enter your current password.';
  if (!next) errors.next = 'Enter a new password.';
  else if (next.length < MIN_PASSWORD_LENGTH) errors.next = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  else if (current && next === current) errors.next = 'Choose a password different from your current one.';
  if (!confirm) errors.confirm = 'Confirm your new password.';
  else if (next && confirm !== next) errors.confirm = "Passwords don't match.";
  return errors;
}
