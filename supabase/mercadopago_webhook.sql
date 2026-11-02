create or replace function private.update_payment_by_provider(
  p_provider_order_id text,
  p_provider_status text,
  p_payment_status text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text := lower(trim(coalesce(p_payment_status, '')));
  v_code text;
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
  where provider_order_id = p_provider_order_id
    and payment_provider = 'mercado_pago'
  returning code into v_code;

  return v_code;
end;
$$;

create or replace function public.update_payment_by_provider_internal(
  p_provider_order_id text,
  p_provider_status text,
  p_payment_status text
)
returns text language sql security invoker set search_path = ''
as $$ select private.update_payment_by_provider(p_provider_order_id, p_provider_status, p_payment_status); $$;

revoke all on function private.update_payment_by_provider(text, text, text) from public, anon, authenticated;
revoke all on function public.update_payment_by_provider_internal(text, text, text) from public, anon, authenticated;
grant execute on function private.update_payment_by_provider(text, text, text) to service_role;
grant execute on function public.update_payment_by_provider_internal(text, text, text) to service_role;

