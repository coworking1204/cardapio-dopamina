# Beta de pedidos

Esta branch (`codex/beta-pedidos`) é isolada do cardápio público.

## Primeira etapa

- Carrinho local, sem cadastro.
- Quantidade, remoção e subtotal.
- Suporte aos dois tamanhos dos petiscos.
- Preços e promoções continuam vindo do cardápio atual.
- Nenhum pagamento é criado.

## Segunda etapa

- Identificação como convidado por nome e WhatsApp.
- Validação e formatação do telefone.
- Resumo antes da confirmação.
- Número de pedido, QR Code e tela de retirada.
- Pedido gravado no Supabase com token aleatório, validade de 12 horas e uso único.
- Valores recalculados no banco com os preços oficiais do cardápio.

## Próximas etapas

1. Liberar a chave de edição no celular usado pela retirada.
2. Testar pedidos durante uma operação controlada.
3. Mercado Pago em ambiente de teste.
4. Leitor de QR pela câmera dentro da tela da equipe.

Não envie esta branch para `main` ou `gh-pages` antes da aprovação da beta.
