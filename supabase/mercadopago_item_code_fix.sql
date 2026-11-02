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

revoke all on function private.create_payment_order(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function private.create_payment_order(text, text, text, jsonb) to service_role;
