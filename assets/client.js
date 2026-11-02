import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js?v=202611021720';

// Chave de edição: vem do link secreto (admin.html#chave=...) e fica guardada neste aparelho.
// Só a página de edição usa; o cardápio público nunca envia a chave.
function readEditKey() {
  if (!document.body.classList.contains('admin-page')) return null;
  const fromLink = new URLSearchParams(location.hash.slice(1)).get('chave');
  try {
    if (fromLink) localStorage.setItem('menu-edit-key', fromLink);
    return fromLink || localStorage.getItem('menu-edit-key');
  } catch {
    return fromLink;
  }
}

export const editKey = readEditKey();

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
  global: { headers: editKey ? { 'x-menu-key': editKey } : {} },
});
