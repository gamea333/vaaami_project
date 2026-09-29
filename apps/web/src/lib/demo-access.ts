const storageKey = `vaami.demo-code:${(import.meta.env.VITE_BOT_BASE_URL ?? "http://127.0.0.1:7860").replace(/\/$/, "")}`;
export function readDemoCode(): string {
  try { return localStorage.getItem(storageKey) ?? ""; } catch { return ""; }
}
export function rememberDemoCode(code: string): boolean {
  try {
    if (code.trim()) localStorage.setItem(storageKey, code.trim());
    else localStorage.removeItem(storageKey);
    return true;
  } catch { return false; }
}
