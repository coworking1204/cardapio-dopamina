import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js?v=202611021747';

// Chave de edição: vem do link secreto (admin.html#chave=...) e fica guardada neste aparelho.
// Só a página de edição usa; o cardápio público nunca envia a chave.
function readEditKey() {
  if (!document.body.classList.contains('admin-page')) return null;
  const scannerPage = document.body.classList.contains('scanner-page');
  const scannerKey = new URLSearchParams(location.hash.slice(1)).get('acesso');
  const fromLink = new URLSearchParams(location.hash.slice(1)).get('chave');
  try {
    if (scannerPage && scannerKey) localStorage.setItem('staff-scanner-key', scannerKey);
    if (fromLink) localStorage.setItem('menu-edit-key', fromLink);
    const savedScannerKey = scannerPage && localStorage.getItem('staff-scanner-key');
    const savedMenuKey = fromLink || localStorage.getItem('menu-edit-key');
    if (scannerKey || fromLink) history.replaceState(null, '', `${location.pathname}${location.search}`);
    return {
      key: scannerKey || savedScannerKey || savedMenuKey,
      header: scannerKey || savedScannerKey ? 'x-scanner-key' : 'x-menu-key',
    };
  } catch {
    return { key: scannerKey || fromLink, header: scannerKey ? 'x-scanner-key' : 'x-menu-key' };
  }
}

const access = readEditKey();
export const editKey = access?.key || null;

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
  global: { headers: editKey ? { [access.header]: editKey } : {} },
});
