// Fake auth: the email is kept in localStorage, nothing is verified.
const KEY = "helios:user";

export function getUser(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function signIn(email: string) {
  try {
    localStorage.setItem(KEY, email);
  } catch {}
}

export function signOut() {
  try {
    localStorage.removeItem(KEY);
  } catch {}
}
