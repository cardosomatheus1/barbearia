-- ============================================================================
-- 0023 — A tolerância do combo
--
-- A regra V1 do validador (SPEC §5.7) diz: "combo com duração < soma das partes
-- **− tolerância declarada**". A tolerância não existia, e sem ela a regra
-- acusaria todo combo legítimo.
--
-- Ela é real, não é folga inventada: cortar cabelo e fazer a barba na sequência
-- é mais rápido do que os dois atendimentos separados — não se troca de cliente,
-- não se limpa a estação duas vezes, não se repete a conversa inicial. Quanto
-- disso se ganha é da casa, não do produto.
--
-- Padrão zero de propósito. Combo cadastrado sem ninguém pensar no assunto tem
-- que **aparecer** no validador — é justamente o defeito D4, o mais caro
-- encontrado em campo. Quem declara a tolerância está dizendo "eu sei que é mais
-- rápido e sei quanto"; o padrão não pode dizer isso por ninguém.
-- ============================================================================

ALTER TABLE service_combos
  ADD COLUMN tolerance_minutes smallint NOT NULL DEFAULT 0,
  /**
   * Teto de uma hora.
   *
   * Acima disso a "tolerância" deixou de descrever o ganho da sequência e virou
   * um jeito de calar o validador — que é o único uso que a regra não pode
   * permitir, porque é o defeito voltando pela porta dos fundos.
   */
  ADD CONSTRAINT service_combos_tolerancia_sana
    CHECK (tolerance_minutes >= 0 AND tolerance_minutes <= 60);
