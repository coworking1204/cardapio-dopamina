-- Checkout Pro (Orders API) para o beta de pedidos.
-- A credencial do Mercado Pago fica somente nas Edge Functions.

alter table public.orders
  add column if not exists customer_email text,
  add column if not exists payment_provider text not null default 'sandbox',
  add column if not exists provider_order_id text,
  add column if not exists provider_status text,
  add column if not exists payment_updated_at timestamptz;

alter table public.orders drop constraint if exists orders_payment_provider_check;
alter table public.orders add constraint orders_payment_provider_check
  check (payment_provider in ('sandbox', 'mercado_pago'));

create unique index if not exists orders_provider_order_id_uidx
  on public.orders (provider_order_id)
  where provider_order_id is not null;

create index if not exists orders_payment_status_created_at_idx
  on public.orders (payment_status, created_at desc);

create or replace function private.create_payment_order(
  p_customer_name text,
  p_customer_phone text,
  p_customer_email text,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(trim(coalesce(p_customer_email, '')));
  v_order jsonb;
  v_code text;
begin
  if char_length(v_email) not between 5 and 160
     or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'E-mail inválido';
  end if;

  v_order := private.create_guest_order(p_customer_name, p_customer_phone, p_items);
  v_code := v_order ->> 'code';

  update public.orders
  set customer_email = v_email,
      payment_provider = 'mercado_pago',
      payment_status = 'pending',
      payment_updated_at = now(),
      expires_at = now() + interval '1 day'
  where code = v_code;

  return v_order || jsonb_build_object(
    'payment_status', 'pending',
    'customer_email', v_email,
    'items', (
      select jsonb_agg(jsonb_build_object(
        'external_code', i.id::text,
        'title', left(i.item_name, 120),
        'description', left(concat_ws(' · ', nullif(i.item_detail, ''), nullif(i.variant_label, '')), 250),
        'quantity', i.quantity,
        'unit_price', to_char(i.unit_price, 'FM999999990.00')
      ) order by i.id)
      from public.order_items i
      join public.orders o on o.id = i.order_id
      where o.code = v_code
    )
  );
end;
$$;

create or replace function private.attach_payment_provider_order(
  p_code text,
  p_provider_order_id text,
  p_provider_status text
)
returns boolean
language sql
security definer
set search_path = ''
as $$
  update public.orders
  set provider_order_id = nullif(trim(p_provider_order_id), ''),
      provider_status = nullif(trim(p_provider_status), ''),
      payment_updated_at = now()
  where code = p_code
    and payment_provider = 'mercado_pago'
    and payment_status = 'pending'
  returning true;
$$;

create or replace function private.fail_payment_order(p_code text, p_provider_status text)
returns boolean
language sql
security definer
set search_path = ''
as $$
  update public.orders
  set payment_status = case when payment_status = 'paid' then 'paid' else 'failed' end,
      provider_status = nullif(trim(p_provider_status), ''),
      payment_updated_at = now()
  where code = p_code and payment_provider = 'mercado_pago'
  returning true;
$$;

create or replace function private.get_payment_sync(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'code', o.code,
    'provider_order_id', o.provider_order_id,
    'payment_status', o.payment_status,
    'total', o.total,
    'expires_at', o.expires_at
  )
  from public.orders o
  where char_length(coalesce(p_token, '')) = 48
    and o.pickup_token_hash = extensions.digest(p_token, 'sha256')
    and o.payment_provider = 'mercado_pago'
  limit 1;
$$;

create or replace function private.update_payment_sync(
  p_token text,
  p_provider_status text,
  p_payment_status text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text := lower(trim(coalesce(p_payment_status, '')));
begin
  if v_status not in ('pending', 'paid', 'failed', 'refunded') then
    raise exception 'Status de pagamento inválido';
  end if;

  update public.orders
  set payment_status = case
        when payment_status = 'paid' and v_status <> 'refunded' then 'paid'
        else v_status
      end,
      provider_status = left(nullif(trim(p_provider_status), ''), 120),
      payment_updated_at = now()
  where char_length(coalesce(p_token, '')) = 48
    and pickup_token_hash = extensions.digest(p_token, 'sha256')
    and payment_provider = 'mercado_pago';

  return private.get_guest_order(p_token);
end;
$$;

-- Pagamentos pendentes nunca aparecem para a portaria e nunca podem ser resgatados.
create or replace function private.list_open_orders(p_limit integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.has_staff_key() then
    raise exception 'Acesso não autorizado';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'code', q.code,
      'customer_name', q.customer_name,
      'quantity', q.item_count,
      'total', q.total,
      'created_at', q.created_at,
      'expires_at', q.expires_at
    ) order by q.created_at desc)
    from (
      select o.code, o.customer_name, o.item_count, o.total, o.created_at, o.expires_at
      from public.orders o
      where o.status = 'created'
        and o.payment_status in ('sandbox', 'paid')
        and o.expires_at > now()
      order by o.created_at desc
      limit least(greatest(coalesce(p_limit, 30), 1), 100)
    ) q
  ), '[]'::jsonb);
end;
$$;

create or replace function private.redeem_guest_order(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
begin
  if not public.has_staff_key() then raise exception 'Acesso não autorizado'; end if;

  update public.orders
  set status = 'redeemed', redeemed_at = now()
  where char_length(coalesce(p_token, '')) = 48
    and pickup_token_hash = extensions.digest(p_token, 'sha256')
    and status = 'created'
    and payment_status in ('sandbox', 'paid')
    and expires_at > now()
  returning * into v_order;

  if found then
    return jsonb_build_object('ok', true, 'code', v_order.code, 'status', v_order.status, 'redeemed_at', v_order.redeemed_at);
  end if;

  select * into v_order from public.orders
  where char_length(coalesce(p_token, '')) = 48
    and pickup_token_hash = extensions.digest(p_token, 'sha256') limit 1;

  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found');
  elsif v_order.payment_status not in ('sandbox', 'paid') then return jsonb_build_object('ok', false, 'reason', 'payment_pending', 'code', v_order.code);
  elsif v_order.status = 'redeemed' then return jsonb_build_object('ok', false, 'reason', 'already_redeemed', 'code', v_order.code, 'redeemed_at', v_order.redeemed_at);
  elsif v_order.expires_at <= now() then return jsonb_build_object('ok', false, 'reason', 'expired', 'code', v_order.code);
  else return jsonb_build_object('ok', false, 'reason', v_order.status, 'code', v_order.code);
  end if;
end;
$$;

create or replace function private.redeem_guest_order_by_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
begin
  if not public.has_staff_key() then raise exception 'Acesso não autorizado'; end if;

  update public.orders
  set status = 'redeemed', redeemed_at = now()
  where upper(code) = upper(trim(coalesce(p_code, '')))
    and status = 'created'
    and payment_status in ('sandbox', 'paid')
    and expires_at > now()
  returning * into v_order;

  if found then
    return jsonb_build_object('ok', true, 'code', v_order.code, 'status', v_order.status, 'redeemed_at', v_order.redeemed_at);
  end if;

  select * into v_order from public.orders
  where upper(code) = upper(trim(coalesce(p_code, ''))) limit 1;

  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found');
  elsif v_order.payment_status not in ('sandbox', 'paid') then return jsonb_build_object('ok', false, 'reason', 'payment_pending', 'code', v_order.code);
  elsif v_order.status = 'redeemed' then return jsonb_build_object('ok', false, 'reason', 'already_redeemed', 'code', v_order.code, 'redeemed_at', v_order.redeemed_at);
  elsif v_order.expires_at <= now() then return jsonb_build_object('ok', false, 'reason', 'expired', 'code', v_order.code);
  else return jsonb_build_object('ok', false, 'reason', v_order.status, 'code', v_order.code);
  end if;
end;
$$;

-- Wrappers exclusivos para Edge Functions (service_role).
create or replace function public.create_payment_order_internal(
  p_customer_name text,
  p_customer_phone text,
  p_customer_email text,
  p_items jsonb
)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.create_payment_order(p_customer_name, p_customer_phone, p_customer_email, p_items); $$;

create or replace function public.attach_payment_provider_order_internal(p_code text, p_provider_order_id text, p_provider_status text)
returns boolean language sql security invoker set search_path = ''
as $$ select private.attach_payment_provider_order(p_code, p_provider_order_id, p_provider_status); $$;

create or replace function public.fail_payment_order_internal(p_code text, p_provider_status text)
returns boolean language sql security invoker set search_path = ''
as $$ select private.fail_payment_order(p_code, p_provider_status); $$;

create or replace function public.get_payment_sync_internal(p_token text)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.get_payment_sync(p_token); $$;

create or replace function public.update_payment_sync_internal(p_token text, p_provider_status text, p_payment_status text)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.update_payment_sync(p_token, p_provider_status, p_payment_status); $$;

revoke all on function private.create_payment_order(text, text, text, jsonb) from public, anon, authenticated;
revoke all on function private.attach_payment_provider_order(text, text, text) from public, anon, authenticated;
revoke all on function private.fail_payment_order(text, text) from public, anon, authenticated;
revoke all on function private.get_payment_sync(text) from public, anon, authenticated;
revoke all on function private.update_payment_sync(text, text, text) from public, anon, authenticated;
revoke all on function public.create_payment_order_internal(text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.attach_payment_provider_order_internal(text, text, text) from public, anon, authenticated;
revoke all on function public.fail_payment_order_internal(text, text) from public, anon, authenticated;
revoke all on function public.get_payment_sync_internal(text) from public, anon, authenticated;
revoke all on function public.update_payment_sync_internal(text, text, text) from public, anon, authenticated;

grant usage on schema private to service_role;
grant execute on function private.create_payment_order(text, text, text, jsonb) to service_role;
grant execute on function private.attach_payment_provider_order(text, text, text) to service_role;
grant execute on function private.fail_payment_order(text, text) to service_role;
grant execute on function private.get_payment_sync(text) to service_role;
grant execute on function private.update_payment_sync(text, text, text) to service_role;
grant execute on function public.create_payment_order_internal(text, text, text, jsonb) to service_role;
grant execute on function public.attach_payment_provider_order_internal(text, text, text) to service_role;
grant execute on function public.fail_payment_order_internal(text, text) to service_role;
grant execute on function public.get_payment_sync_internal(text) to service_role;
grant execute on function public.update_payment_sync_internal(text, text, text) to service_role;

