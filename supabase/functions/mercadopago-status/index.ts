const BETA_ORIGIN = 'https://dopamina-cardapio-beta.vercel.app';
const allowedOrigins = new Set([BETA_ORIGIN, 'http://127.0.0.1:4173', 'http://localhost:4173']);

function cors(origin: string | null) {
  const value = origin && allowedOrigins.has(origin) ? origin : BETA_ORIGIN;
  return {
    'Access-Control-Allow-Origin': value,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

function json(body: unknown, status = 200, origin: string | null = null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(origin), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function secretKey() {
  const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}');
  return keys.default || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
}

async function rpc(name: string, body: unknown) {
  const url = Deno.env.get('SUPABASE_URL');
  const key = secretKey();
  if (!url || !key) throw new Error('Supabase server credentials unavailable');
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.message || `RPC ${name} failed`);
  return data;
}

function paymentState(order: any) {
  const payments = order?.transactions?.payments || [];
  if (order?.status === 'refunded' || payments.some((p: any) => p.status === 'refunded')) return 'refunded';
  if (order?.status === 'processed' || payments.some((p: any) => p.status === 'processed')) return 'paid';
  if (['failed', 'cancelled', 'expired'].includes(order?.status) || payments.some((p: any) => ['failed', 'cancelled', 'expired'].includes(p.status))) return 'failed';
  return 'pending';
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405, origin);
  if (!origin || !allowedOrigins.has(origin)) return json({ error: 'Origem não permitida' }, 403, origin);

  const accessToken = Deno.env.get('MERCADOPAGO_ACCESS_TOKEN');
  if (!accessToken) return json({ error: 'Pagamento ainda não configurado' }, 503, origin);

  let token = '';
  try { token = String((await req.json())?.token || ''); } catch { /* empty */ }
  if (!/^[a-f0-9]{48}$/i.test(token)) return json({ error: 'Pedido inválido' }, 400, origin);

  try {
    const local = await rpc('get_payment_sync_internal', { p_token: token });
    if (!local?.provider_order_id) return json({ error: 'Pagamento não encontrado' }, 404, origin);
    if (local.payment_status === 'paid') return json({ payment_status: 'paid', order: await rpc('update_payment_sync_internal', { p_token: token, p_provider_status: 'processed', p_payment_status: 'paid' }) });

    const response = await fetch(`https://api.mercadopago.com/v1/orders/${encodeURIComponent(local.provider_order_id)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const mp = await response.json().catch(() => ({}));
    if (!response.ok) return json({ payment_status: local.payment_status || 'pending' }, 200, origin);

    const state = paymentState(mp);
    const order = await rpc('update_payment_sync_internal', {
      p_token: token,
      p_provider_status: `${mp.status || 'unknown'}:${mp.status_detail || ''}`,
      p_payment_status: state,
    });
    return json({ payment_status: state, order });
  } catch {
    return json({ error: 'Não foi possível consultar o pagamento' }, 502, origin);
  }
});

