-- ============================================================================
-- 0040 — O segundo fator do dinheiro vira decisão da barbearia
--
-- ## O que muda
--
-- Até aqui o segundo fator era **imposto**: qualquer conta com permissão do
-- grupo de dinheiro precisava de TOTP cadastrado e confirmado nos últimos trinta
-- minutos para abrir o caixa, ver faturamento ou fechar comanda. A regra vinha
-- do `CLAUDE.md` e a `PermissaoGuard` a derivava da permissão declarada na rota,
-- que continua sendo o desenho certo — o que estava errado era não haver
-- interruptor.
--
-- ## Por que nasce desligado
--
-- Pela regra que este repositório já aplica a toda configuração que mexe em
-- dinheiro: **o padrão é o comportamento anterior**. Só que aqui "anterior"
-- precisa de cuidado — ligado *era* o comportamento do código, e mesmo assim o
-- padrão é `false`.
--
-- A razão é que o comportamento anterior nunca foi escolhido por ninguém. A
-- barbearia de bairro que instala o produto numa terça-feira e tenta abrir o
-- caixa na quarta encontra "ative o segundo fator antes de acessar o
-- financeiro" — sobre uma conta recém-criada, num aplicativo autenticador que
-- ela não tem, com o cliente esperando na cadeira. O resultado previsível não é
-- mais segurança: é a recepção operando com a conta do dono, que é exatamente o
-- que o segundo fator existia para impedir.
--
-- Ligado por decisão vale mais que ligado por imposição. Quem liga sabe por
-- que, tem o aplicativo instalado e escolheu o momento.
--
-- ## O que **não** muda
--
-- A derivação. A guarda continua cobrando a partir de `PERMISSOES_DE_DINHEIRO`,
-- e uma rota de dinheiro escrita no bloco 50 continua nascendo coberta. O que
-- esta coluna decide é se a cobrança acontece — nunca *quais* rotas ela alcança,
-- que é a parte que ninguém pode esquecer de declarar.
-- ============================================================================

ALTER TABLE tenants
  ADD COLUMN require_mfa_for_money boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN tenants.require_mfa_for_money IS
  'Quando verdadeiro, a PermissaoGuard exige segundo fator confirmado nos '
  'últimos 30 minutos para toda rota que declare permissão de PERMISSOES_DE_'
  'DINHEIRO. Nasce falso: ligado por decisão vale mais que ligado por '
  'imposição, e imposto ele produzia a recepção operando com a conta do dono.';
