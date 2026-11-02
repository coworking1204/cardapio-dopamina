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
  const paymentData = input?.payment_data && typeof input.payment_data === 'object' ? input.payment_data : {};
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

  const amount = Number(order.total);
  const idempotencyKey = crypto.randomUUID();
  const paymentMethodId = String(paymentData.payment_method_id || paymentData.paymentMethodId || '').trim();
  const tokenizedCard = String(paymentData.token || '').trim();
  const installments = Math.min(12, Math.max(1, Number(paymentData.installments) || 1));
  const issuerId = String(paymentData.issuer_id || paymentData.issuerId || '').trim();
  const identification = paymentData?.payer?.identification || {};
  if (!/^[a-z0-9_-]{2,40}$/i.test(paymentMethodId)) {
    await rpc('fail_payment_order_internal', { p_code: order.code, p_provider_status: 'invalid_payment_method' });
    return json({ error: 'Forma de pagamento inválida' }, 400, origin);
  }
  if (paymentMethodId !== 'pix' && !tokenizedCard) {
    await rpc('fail_payment_order_internal', { p_code: order.code, p_provider_status: 'missing_card_token' });
    return json({ error: 'Dados do cartão incompletos' }, 400, origin);
  }
  const payload: any = {
    transaction_amount: amount,
    description: `Pedido ${order.code} · Dopamina`,
    payment_method_id: paymentMethodId,
    installments,
    external_reference: order.code,
    payer: {
      email,
      first_name: name.split(' ')[0],
      last_name: name.split(' ').slice(1).join(' ') || undefined,
      identification: identification?.type && identification?.number ? {
        type: String(identification.type).slice(0, 10),
        number: String(identification.number).replace(/\D/g, '').slice(0, 20),
      } : undefined,
    },
    statement_descriptor: 'DOPAMINA',
    notification_url: `${Deno.env.get('SUPABASE_URL')}/functions/v1/mercadopago-webhook`,
    metadata: { order_code: order.code },
  };
  if (tokenizedCard) payload.token = tokenizedCard;
  if (issuerId) payload.issuer_id = issuerId;

  try {
    const response = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(payload),
    });
    const mp = await response.json().catch(() => ({}));
    if (!response.ok || !mp.id) {
      const detail = JSON.stringify(mp?.errors || mp?.error || mp?.message || mp?.code || `http_${response.status}`).slice(0, 120);
      console.error('Mercado Pago create order failed', response.status, detail);
      await rpc('fail_payment_order_internal', { p_code: order.code, p_provider_status: detail });
      return json({ error: 'O pagamento não pôde ser processado' }, 502, origin);
    }
    await rpc('attach_payment_provider_order_internal', {
      p_code: order.code,
      p_provider_order_id: `pay_${mp.id}`,
      p_provider_status: mp.status || 'created',
    });
    const paymentStatus = mp.status === 'approved' ? 'paid' : ['rejected', 'cancelled', 'refunded', 'charged_back'].includes(mp.status) ? 'failed' : 'pending';
    if (paymentStatus !== 'pending') {
      await rpc('update_payment_by_provider_internal', {
        p_provider_order_id: `pay_${mp.id}`,
        p_provider_status: `${mp.status || 'unknown'}:${mp.status_detail || ''}`,
        p_payment_status: paymentStatus,
      });
    }
    const transactionData = mp?.point_of_interaction?.transaction_data || {};
    return json({
      payment_status: paymentStatus,
      pix: paymentMethodId === 'pix' ? {
        qr_code: transactionData.qr_code || null,
        qr_code_base64: transactionData.qr_code_base64 || null,
      } : null,
      order: { code: order.code, token: order.token, quantity: order.quantity, total: order.total, payment_status: paymentStatus },
    }, 201, origin);
  } catch {
    await rpc('fail_payment_order_internal', { p_code: order.code, p_provider_status: 'network_error' }).catch(() => {});
    return json({ error: 'Não foi possível conectar ao Mercado Pago' }, 502, origin);
  }
});

