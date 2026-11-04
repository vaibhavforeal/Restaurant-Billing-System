/** What is wrong with the admin's sign-in, checked before setup is sent; null when it can go. */
export function adminProblem({ username, password, confirm, pin }: { username: string; password: string; confirm: string; pin: string }): string | null {
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username.trim().toLowerCase())) return "Use 3-32 letters, numbers, dots, dashes or underscores for the username, starting with a letter or number.";
  if (password.length < 8) return "Use at least 8 characters for the password.";
  if (!password.trim()) return "The password cannot be only spaces.";
  if (password !== confirm) return "The two passwords do not match.";
  if (!/^\d{4,6}$/.test(pin)) return "The approval PIN must be 4-6 digits.";
  return null;
}
