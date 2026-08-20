-- ---------------------------------------------------------------------------
-- Fechamento de comissão por unidade (bloco 117)
--
-- `commission_entries` sempre soube de qual profissional é o lançamento, e
-- `professionals.location_id` sempre disse em que loja ele trabalha. O que não
-- existia era o recorte: `extratoDeComissao`, `fechamentosDeComissao` e
-- `fecharPeriodoDeComissao` liam a barbearia inteira.
--
-- O sintoma foi reproduzido de ponta a ponta: a gerente escopada à filial abria
-- a tela de Comissão e lia "A CASA TEM A PAGAR R$ 7.676,40" com os três
-- barbeiros da matriz nomeados e o botão "Fechar o período" ao lado — uma ação
-- que o gatilho torna imutável. Na mesma sessão, o DRE da filial dizia R$ 30,80:
-- duas telas do mesmo painel, mesmo período, 250 vezes de diferença.
--
-- ## Por que a coluna, e não uma recusa na borda
--
-- Recusar o fechamento a quem não opera a rede inteira fecharia o vazamento e
-- deixaria a rede sem como pagar por loja — cada filial tem folha própria, e o
-- acerto do barbeiro é o documento que ele confere. A coluna é o modelo certo:
-- nula é o fechamento da rede, que é o que toda barbearia existente tem hoje.
--
-- O índice único vira dois parciais pela mesma razão de sempre: no Postgres,
-- `NULL` não colide com `NULL` num índice único comum, então a rede poderia ser
-- fechada duas vezes para o mesmo período.
-- ---------------------------------------------------------------------------

ALTER TABLE commission_closures
  ADD COLUMN IF NOT EXISTS location_id uuid REFERENCES locations(id) ON DELETE RESTRICT;

COMMENT ON COLUMN commission_closures.location_id IS
  'A loja cujo periodo foi fechado. Nula e o fechamento da rede inteira, que e '
  'o que existia antes do bloco 117 e continua sendo o padrao de quem tem uma '
  'loja so.';

DROP INDEX IF EXISTS commission_closures_periodo_unico;

CREATE UNIQUE INDEX IF NOT EXISTS commission_closures_periodo_da_loja
  ON commission_closures (tenant_id, location_id, starts_on, ends_on)
  WHERE location_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS commission_closures_periodo_da_rede
  ON commission_closures (tenant_id, starts_on, ends_on)
  WHERE location_id IS NULL;
