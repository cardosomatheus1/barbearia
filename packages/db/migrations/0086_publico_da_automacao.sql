-- ---------------------------------------------------------------------------
-- 0086 — o público da automação: "quando · só para · mandar" (bloco 100)
--
-- A automação sabia **quando** disparar e **o que** mandar, e não sabia **para
-- quem**. "Sumiu há 30 dias" ia para todo mundo que sumiu há 30 dias — o
-- assinante que paga mensalidade e o visitante de uma vez só, com a mesma
-- frase. Quem opera queria combinar as duas coisas desde sempre: "quem sumiu
-- **e** é VIP", "primeiro atendimento **e** ainda não voltou".
--
-- O público é o **segmento derivado** do bloco 61, e não um filtro novo: ele já
-- existe, já é calculado em `packages/core` sobre a base inteira, e a campanha
-- já o usa. Uma segunda noção de "quem é este cliente" seria a lista paralela
-- que este repositório mais cataloga.
--
-- Nulo é **todo mundo**, e é o comportamento anterior: padrão de configuração é
-- sempre o que já acontecia. Uma automação existente não muda de público no dia
-- da migração.
--
-- Reaplicável, como toda migração depois da baseline do livro-caixa.
-- ---------------------------------------------------------------------------

ALTER TABLE automations
  ADD COLUMN IF NOT EXISTS audience text;

COMMENT ON COLUMN automations.audience IS
  'Segmento do bloco 61 a que esta automação se restringe. NULL = todo mundo.';

-- O conjunto é o de `SEGMENTOS` em packages/core. Escrito aqui porque o banco é
-- a garantia e a borda é a mensagem: sem a CHECK, um segmento inventado por
-- outro chamador viraria automação que nunca dispara, em silêncio.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'automations_publico_conhecido'
  ) THEN
    ALTER TABLE automations
      ADD CONSTRAINT automations_publico_conhecido CHECK (
        audience IS NULL OR audience IN (
          'novo', 'ativo', 'frequente', 'vip', 'em_risco', 'perdido', 'assinante'
        )
      );
  END IF;
END $$;
