-- ============================================================================
-- 0077 — contestar uma avaliação (bloco 80, SPEC §4.10)
--
-- ## Contestar não é apagar, e a diferença é o produto inteiro
--
-- O bloco 43 fechou com a nota baixa publicando **de qualquer forma** depois de
-- 48 horas, e com três camadas impedindo apagar. Isso está certo para a nota
-- ruim e verdadeira, e deixa sem resposta a nota ruim e **injusta** — spam,
-- ofensa, nota atribuída ao profissional errado, gente que nunca foi cliente.
-- Contra essa, o dono não tinha nada, e é reclamação justa.
--
-- A contestação é o meio-termo:
--
-- | | Apagar | Contestar |
-- |---|---|---|
-- | Motivo | nenhum | lista fechada, registrado e auditado |
-- | Efeito | some para sempre | **suspensa** da vitrine enquanto está em análise |
-- | Nota e texto | apagáveis | continuam imutáveis |
-- | Média do painel | muda | **não muda** |
--
-- A última linha é a que importa mais. A média que o gestor vê conta tudo —
-- publicado ou não —, e é a distância entre ela e a média pública que diz "o
-- Bruno está com 4,8 na rua e 3,9 de verdade". Se contestar mexesse na média
-- interna, o dono cegaria o próprio termômetro com o botão que o produto lhe
-- deu. Por isso a suspensão vive **só** no predicado do que é público.
--
-- ## O motivo é de lista fechada, e é aí que mora a garantia
--
-- Texto livre viraria "não gostei", e "não gostei" é apagar com outro nome. Os
-- cinco valores descrevem coisas que ou aconteceram ou não aconteceram, e é
-- isso que torna a contestação auditável em vez de discricionária.
-- ============================================================================

CREATE TYPE review_contest_reason AS ENUM (
  /** Propaganda, texto repetido, link. */
  'spam',
  /** Ofensa pessoal, discurso de ódio, ameaça. */
  'ofensa',
  /** A nota é de outra pessoa da equipe. */
  'profissional_errado',
  /** Não há atendimento concluído desta pessoa nesta casa. */
  'nunca_foi_cliente',
  /** A mesma avaliação, de novo. */
  'duplicada'
);

ALTER TABLE reviews
  ADD COLUMN contested_at     timestamptz,
  ADD COLUMN contest_reason   review_contest_reason,
  ADD COLUMN contested_by     uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  /** O detalhe que o motivo não carrega. Obrigatório, como todo motivo escrito. */
  ADD COLUMN contest_note     text,
  ADD CONSTRAINT reviews_contestacao_completa CHECK (
    (contested_at IS NULL AND contest_reason IS NULL AND contest_note IS NULL)
    OR (contested_at IS NOT NULL AND contest_reason IS NOT NULL
        AND contest_note IS NOT NULL AND length(btrim(contest_note)) >= 10)
  );

/**
 * O índice do que **sai** da vitrine.
 *
 * Parcial no contestado, porque é a minoria absoluta: a consulta pública filtra
 * por `contested_at IS NULL`, e um índice sobre a coluna inteira seria quase
 * todas as linhas da tabela.
 */
CREATE INDEX reviews_contestadas
  ON reviews (tenant_id, contested_at DESC) WHERE contested_at IS NOT NULL;

COMMENT ON COLUMN reviews.contested_at IS
  'Suspensa da vitrine, nunca apagada. A media do painel continua contando '
  'esta nota — a distancia entre ela e a media publica e a informacao.';

/**
 * A contestação não se **reescreve** — mas se **retira**, e a diferença é o
 * bloco inteiro.
 *
 * O gatilho do bloco 43 já recusa mexer em `rating`, `comment` e nas quatro
 * categorias, e as colunas novas não estão naquela lista — então contestar
 * passa. O que se acrescenta aqui é o outro lado: trocar o motivo depois de
 * gravado apagaria o registro de por que a casa suspendeu a nota, que é
 * justamente o que torna a suspensão auditável em vez de discricionária.
 *
 * **Retirar, sim.** Um estado sem saída seria apagar com mais passos: a casa
 * contesta por engano, a nota some da vitrine para sempre e não há caminho de
 * volta em tela nenhuma — que é exatamente o que a SPEC §4.10 proíbe, e a
 * pergunta 3 da §6 deste repositório. A condição do gatilho olha as **duas**
 * pontas: reescrever uma contestação viva é recusado, e limpá-la por inteiro —
 * que é o que a rota de retirada faz, e o que o `CHECK` exige que seja por
 * inteiro — passa. Recontestar com outro motivo continua possível em dois
 * passos, e os dois ficam na trilha.
 *
 * A direção também importa: retirar devolve a nota ao ar. É o sentido seguro,
 * e por isso a saída não precisa de permissão mais alta que a entrada.
 */
CREATE OR REPLACE FUNCTION reviews_contestacao_imutavel() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  /**
   * A anonimização passa.
   *
   * Ela solta o cliente da avaliação e o gatilho anterior troca a justificativa
   * pelo marcador — os dois rodam como donos da tabela, pelo mesmo caminho por
   * que `reviews_nota_imutavel` é desligado ali. Sem esta saída, o direito à
   * exclusão morreria dentro do gatilho que existe para proteger a avaliação.
   */
  IF OLD.customer_id IS NOT NULL AND NEW.customer_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF OLD.contested_at IS NOT NULL AND NEW.contested_at IS NOT NULL AND (
       NEW.contested_at IS DISTINCT FROM OLD.contested_at
       OR NEW.contest_reason IS DISTINCT FROM OLD.contest_reason
       OR NEW.contest_note IS DISTINCT FROM OLD.contest_note
     )
  THEN
    RAISE EXCEPTION 'a contestação não se reescreve — retire e conteste de novo'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER reviews_contestacao_imutavel
  BEFORE UPDATE ON reviews
  FOR EACH ROW EXECUTE FUNCTION reviews_contestacao_imutavel();

-- ---------------------------------------------------------------------------
-- A permissão, no `CHECK` que o bloco 32 criou
--
-- `reviews.contest` é própria, e não `reviews.recover`. Recuperar é agir dentro
-- da janela — ligar, oferecer retrabalho, registrar o desfecho —, e é do balcão.
-- Contestar tira uma nota do ar, e é a única coisa neste produto que decide o
-- que o público **não** vê: ela é do dono, e não vem no papel de recepção nem
-- no de profissional por padrão.
-- ---------------------------------------------------------------------------
ALTER TABLE role_permissions DROP CONSTRAINT IF EXISTS role_permissions_conhecida;
ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_conhecida CHECK (permission IN (
  'appointments.view', 'appointments.create', 'appointments.cancel',
  'appointments.reschedule', 'appointments.view_all_professionals',
  'appointments.attend',
  'cashier.open', 'cashier.close', 'cashier.withdraw',
  'finance.view', 'finance.view_profit', 'finance.export', 'finance.discount',
  'finance.deposit', 'finance.loyalty_adjust', 'finance.package_refund',
  'finance.subscription_manage', 'finance.split_manage',
  'finance.bills_manage', 'finance.credit_limit',
  'finance.advance', 'finance.order_refund', 'finance.package_transfer',
  'fiscal.view', 'fiscal.issue', 'fiscal.settings',
  'commission.view_own', 'commission.view_all', 'commission.edit_rules',
  'customers.view', 'customers.edit', 'customers.export',
  'customers.view_photos', 'customers.manage_photos',
  'customers.view_notes', 'customers.edit_notes',
  'customers.anonymize', 'customers.reliability_override',
  'feedback.view', 'feedback.manage',
  'franchise.manage',
  'reviews.view', 'reviews.recover', 'reviews.contest',
  'reports.finance', 'reports.operational',
  'inventory.view', 'inventory.adjust',
  'marketing.send', 'settings.manage', 'team.manage',
  'whatsapp.manage'
));

/**
 * O dono recebe a permissão; os outros papéis não.
 *
 * `DO NOTHING`, que **respeita quem já decidiu**: a barbearia que tiver
 * desenhado os papéis não tem o desenho sobrescrito por uma migração.
 */
INSERT INTO role_permissions (tenant_id, role, permission)
SELECT t.id, 'owner', 'reviews.contest' FROM tenants t
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- A justificativa sai quando a pessoa sai
--
-- `contest_note` é texto que o balcão escreve **sobre o cliente que avaliou** —
-- "não temos atendimento no nome dela, e o telefone não é de cliente nosso" é o
-- exemplo que a própria tela sugere. Sem isto, quem exercesse o direito à
-- exclusão saía do cadastro e continuava nomeado ali, numa linha que o gatilho
-- acima tinha acabado de tornar imutável: nem apagável, nem corrigível, nem
-- visível na exportação do titular.
--
-- **Gatilho, e não uma linha a mais em `anonimizar_cliente`.** A função é lista
-- escrita e a varredura de catálogo do bloco 34 só olha colunas de `customers`
-- — nenhuma das duas redes pega uma coluna de `reviews`. O gatilho pega
-- qualquer caminho que solte o cliente da avaliação, inclusive o que alguém
-- escrever daqui a dez blocos. É a decisão da revogação de consentimento, que
-- também apaga por gatilho em vez de depender de quem grava lembrar.
--
-- O texto vira marcador em vez de nulo porque o `CHECK` exige a contestação
-- completa, e porque o **motivo** — de lista fechada, que não nomeia ninguém —
-- precisa continuar explicando por que a nota está fora do ar.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reviews_anonimiza_contestacao() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.customer_id IS NOT NULL AND NEW.customer_id IS NULL
     AND NEW.contested_at IS NOT NULL
  THEN
    NEW.contest_note := 'contestacao anonimizada a pedido do titular';
  END IF;
  RETURN NEW;
END $$;

/**
 * Antes de `reviews_contestacao_imutavel` no alfabeto, e é de propósito: o
 * Postgres dispara gatilhos do mesmo evento por ordem de nome, e este precisa
 * escrever o marcador antes de o outro comparar o que mudou.
 */
CREATE TRIGGER reviews_anonimiza_contestacao
  BEFORE UPDATE ON reviews
  FOR EACH ROW EXECUTE FUNCTION reviews_anonimiza_contestacao();
