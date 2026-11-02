# Beta de pedidos

Esta branch (`codex/beta-pedidos`) é isolada do cardápio público.

## Primeira etapa

- Carrinho local, sem cadastro.
- Quantidade, remoção e subtotal.
- Suporte aos dois tamanhos dos petiscos.
- Preços e promoções continuam vindo do cardápio atual.
- Nenhum pedido é gravado no banco e nenhum pagamento é criado.

## Segunda etapa

- Identificação como convidado por nome e WhatsApp.
- Validação e formatação do telefone.
- Resumo antes da confirmação.
- Número de pedido beta e tela de sucesso.
- Simulação armazenada somente no aparelho, sem envio ao bar.

## Próximas etapas

1. Pedido simulado no Supabase beta.
2. QR Code de retirada e painel de validação.
3. Mercado Pago em ambiente de teste.
4. Revisão de segurança antes de qualquer pagamento real.

Não envie esta branch para `main` ou `gh-pages` antes da aprovação da beta.
