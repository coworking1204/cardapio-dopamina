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

## Terceira etapa

- Tela privada `scanner.html`, com uma chave própria que não dá acesso ao editor.
- Leitura do QR Code pela câmera traseira, com alternativa compatível para iPhone.
- Conferência dos itens e entrega de uso único.
- Lista compacta dos pedidos ainda pendentes.

## Próximas etapas

1. Abrir o link privado no celular usado pela retirada.
2. Testar pedidos durante uma operação controlada.
3. Mercado Pago em ambiente de teste.

Não envie esta branch para `main` ou `gh-pages` antes da aprovação da beta.
