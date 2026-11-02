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

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405, origin);
  if (!origin || !allowedOrigins.has(origin)) return json({ error: 'Origem não permitida' }, 403, origin);

  const token = Deno.env.get('MERCADOPAGO_ACCESS_TOKEN');
  if (!token) return json({ error: 'Pagamento ainda não configurado' }, 503, origin);

  let input: any;
  try { input = await req.json(); } catch { return json({ error: 'Dados inválidos' }, 400, origin); }

  const name = String(input?.name || '').trim().replace(/\s+/g, ' ');
  const phone = String(input?.phone || '').replace(/\D/g, '');
  const email = String(input?.email || '').trim().toLowerCase();
  const items = Array.isArray(input?.items) ? input.items : [];
  if (name.length < 2 || name.length > 80 || phone.length < 10 || phone.length > 13 || email.length > 160 || items.length < 1) {
    return json({ error: 'Confira seus dados e o pedido' }, 400, origin);
  }

  let order: any;
  try {
    order = await rpc('create_payment_order_internal', {
      p_customer_name: name,
      p_customer_phone: phone,
      p_customer_email: email,
      p_items: items,
    });
  } catch {
    return json({ error: 'Não foi possível criar o pedido' }, 400, origin);
  }

  const returnUrl = `${BETA_ORIGIN}/?payment=return`;
  const amount = Number(order.total).toFixed(2);
  const idempotencyKey = crypto.randomUUID();
  const names = name.split(' ');
  const areaCode = phone.slice(-11, -9);
  const phoneNumber = phone.slice(-9);
  const payload = {
    type: 'online',
    processing_mode: 'manual',
    capture_mode: 'automatic_async',
    total_amount: amount,
    external_reference: order.code,
    expiration_time: 'P1D',
    payer: {
      email,
      first_name: names.shift() || name,
      last_name: names.join(' ') || undefined,
      phone: { area_code: areaCode, number: phoneNumber },
    },
    config: {
      statement_descriptor: 'DOPAMINA',
      online: {
        success_url: returnUrl,
        failure_url: returnUrl,
        pending_url: returnUrl,
        auto_return: 'approved',
      },
      payment_method: { max_installments: 12 },
    },
    items: order.items,
  };

  try {
    const response = await fetch('https://api.mercadopago.com/v1/orders', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(payload),
    });
    const mp = await response.json().catch(() => ({}));
    if (!response.ok || !mp.id || !mp.checkout_url) {
      const detail = JSON.stringify(mp?.errors || mp?.error || mp?.message || mp?.code || `http_${response.status}`).slice(0, 120);
      console.error('Mercado Pago create order failed', response.status, detail);
      await rpc('fail_payment_order_internal', { p_code: order.code, p_provider_status: detail });
      return json({ error: 'O Mercado Pago não conseguiu abrir o pagamento' }, 502, origin);
    }
    await rpc('attach_payment_provider_order_internal', {
      p_code: order.code,
      p_provider_order_id: mp.id,
      p_provider_status: mp.status || 'created',
    });
    return json({
      checkout_url: mp.checkout_url,
      order: { code: order.code, token: order.token, quantity: order.quantity, total: order.total, payment_status: 'pending' },
    }, 201, origin);
  } catch {
    await rpc('fail_payment_order_internal', { p_code: order.code, p_provider_status: 'network_error' }).catch(() => {});
    return json({ error: 'Não foi possível conectar ao Mercado Pago' }, 502, origin);
  }
});

