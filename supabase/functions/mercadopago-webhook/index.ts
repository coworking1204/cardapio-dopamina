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

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

async function validSignature(dataId: string, requestId: string, signature: string, secret: string) {
  const parts = Object.fromEntries(signature.split(',').map((part) => part.trim().split('=', 2)));
  if (!parts.ts || !parts.v1 || !requestId || !dataId) return false;
  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${parts.ts};`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(manifest));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return timingSafeEqual(hex, parts.v1);
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('ok', { status: 200 });

  const webhookSecret = Deno.env.get('MERCADOPAGO_WEBHOOK_SECRET');
  const accessToken = Deno.env.get('MERCADOPAGO_ACCESS_TOKEN');
  if (!webhookSecret || !accessToken) return new Response('not configured', { status: 503 });

  let body: any = {};
  try { body = await req.json(); } catch { /* invalid payload */ }
  const url = new URL(req.url);
  const dataId = url.searchParams.get('data.id') || String(body?.data?.id || '');
  const signature = req.headers.get('x-signature') || '';
  const requestId = req.headers.get('x-request-id') || '';
  if (!await validSignature(dataId, requestId, signature, webhookSecret)) {
    return new Response('invalid signature', { status: 401 });
  }

  try {
    const response = await fetch(`https://api.mercadopago.com/v1/orders/${encodeURIComponent(dataId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const order = await response.json().catch(() => ({}));
    if (!response.ok || !order?.id) return new Response('temporary failure', { status: 503 });
    await rpc('update_payment_by_provider_internal', {
      p_provider_order_id: order.id,
      p_provider_status: `${order.status || 'unknown'}:${order.status_detail || ''}`,
      p_payment_status: paymentState(order),
    });
    return new Response('ok', { status: 200 });
  } catch {
    return new Response('temporary failure', { status: 503 });
  }
});

