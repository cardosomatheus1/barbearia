-- ============================================================================
-- 0081 — o motivo da contestação de comissão vira lista fechada
--
-- `contested_reason` é texto livre obrigatório, escrito pela barbearia **sobre
-- um cliente específico** — a linha tem `customer_id NOT NULL`. Ele atravessa
-- para o painel da plataforma verbatim, e sobrevive à anonimização.
--
-- Os dois problemas são o mesmo problema visto de dois lados:
--
-- 1. **Para o lado da plataforma.** Para contestar, a recepção escreve a única
--    justificativa natural: *"o João Paulo Ferreira é primo do dono, já corta
--    aqui há três anos, não veio pelo marketplace"*. Esse texto ia íntegro para
--    a tela de quem é **operadora**, não controladora, e não responde por aquele
--    dado. A função que o lê roda `semTenant` de propósito, e o comentário dela
--    diz — corretamente — que o **nome** do cliente não sai. O campo que saía
--    era justamente o único onde alguém escreveria o nome.
--
-- 2. **Para o lado do titular.** O texto ficava depois de a pessoa pedir
--    exclusão, fora da exportação dela, numa tabela que a `anonimizar_cliente`
--    não alcança.
--
-- É o desenho do bloco 80, e pela mesma razão: **texto livre vira "não gostei",
-- e "não gostei" é evasão de receita com outro nome.** A categoria responde a
-- pergunta que a plataforma faz — *"esta renúncia se explica?"* —, e a nota
-- escrita continua existindo do lado da barbearia, que é quem responde pelo
-- dado do cliente dela.
-- ============================================================================

CREATE TYPE attribution_contest_reason AS ENUM (
  /** Já era cliente da casa antes do marketplace. */
  'ja_era_cliente',
  /** Veio por indicação, anúncio próprio ou passou na porta. */
  'veio_por_outro_canal',
  /** O atendimento não aconteceu. */
  'nao_compareceu',
  /** A venda foi estornada ou cancelada. */
  'venda_desfeita',
  /** Erro de cadastro: pessoa duplicada, id trocado. */
  'cadastro_errado'
);

ALTER TABLE marketplace_attributions
  ADD COLUMN contest_reason attribution_contest_reason,
  ADD CONSTRAINT marketplace_attributions_contestacao_completa CHECK (
    status <> 'cancelada' OR contest_reason IS NOT NULL
  );

/**
 * A categoria passa a ser o que o `CHECK` do bloco 72 cobrava da frase.
 *
 * Ele exigia dez caracteres em `contested_reason` para toda linha cancelada, e
 * a razão era boa: renúncia sem porquê escrito é evasão indistinguível de
 * discordância. Só que a frase agora **sai na anonimização** — e o `CHECK`
 * antigo tornava isso impossível, recusando a limpeza que a lei manda fazer.
 *
 * Quem carrega a exigência é a categoria, que não nomeia ninguém e por isso
 * fica. A frase continua obrigatória **na borda e no domínio**, que é onde a
 * pessoa está escrevendo — o banco só deixa de exigi-la para sempre.
 */
ALTER TABLE marketplace_attributions
  DROP CONSTRAINT marketplace_attributions_contestacao_com_motivo;

COMMENT ON COLUMN marketplace_attributions.contest_reason IS
  'A categoria, e e ela que a plataforma le. Lista fechada porque texto livre '
  'vira "nao gostei", e "nao gostei" e evasao de receita com outro nome.';

COMMENT ON COLUMN marketplace_attributions.contested_reason IS
  'A nota escrita, e ela fica do lado da barbearia. NAO sai para o painel da '
  'plataforma: e texto sobre um cliente, e a plataforma e operadora, nao '
  'controladora. Sai na anonimizacao pelo gatilho de customers.';

-- ---------------------------------------------------------------------------
-- E ela sai quando a pessoa sai
--
-- A tabela tem `customer_id NOT NULL` e é append-only para `DELETE`, então nem
-- `anonimizar_cliente` — que é lista escrita — nem a varredura de catálogo do
-- bloco 34 — que só olha colunas de `customers` — a alcançavam. O gatilho da
-- 0079 é o lugar certo: ele dispara quando `anonymized_at` deixa de ser nulo, e
-- pega qualquer caminho que anonimize.
--
-- A **categoria** fica: ela é de lista fechada, não nomeia ninguém, e é o que
-- continua explicando por que a comissão foi renunciada.
-- ---------------------------------------------------------------------------
/**
 * `SECURITY DEFINER` **e** dependente do tenant do chamador — as duas coisas, e
 * o teste levou três voltas para mostrar por quê.
 *
 * São duas barreiras diferentes, e `DEFINER` resolve exatamente uma:
 *
 * - **Privilégio.** `loyalty_entries` tem `REVOKE UPDATE`, e o gatilho como
 *   `INVOKER` roda com o papel da aplicação: `permission denied`. Aqui `DEFINER`
 *   é obrigatório — sem ele o gatilho da 0079 nunca teve como fazer o trabalho.
 * - **Política.** As três tabelas têm `FORCE ROW LEVEL SECURITY`, e `FORCE`
 *   sujeita **até o dono**: `DEFINER` não passa por cima dela. É a mesma pedra
 *   em que a política de `tenant_platform` tropeçou duas migrações atrás.
 *
 * Então o recorte de tenant continua vindo do contexto — e isso está certo,
 * porque o único caminho que anonimiza é `anonimizar_cliente`, que roda
 * `withTenant` por definição: ela precisa do contexto para achar o cliente.
 * `NEW.tenant_id` é a segunda guarda, escrita dentro.
 */
CREATE OR REPLACE FUNCTION customers_anonimiza_textos_satelites() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF OLD.anonymized_at IS NULL AND NEW.anonymized_at IS NOT NULL THEN
    UPDATE public.loyalty_entries
       SET note = NULL
     WHERE customer_id = NEW.id AND tenant_id = NEW.tenant_id AND note IS NOT NULL;

    UPDATE public.data_requests
       SET note = 'texto removido na anonimizacao do titular'
     WHERE customer_id = NEW.id AND tenant_id = NEW.tenant_id
       AND note IS NOT NULL
       AND note <> 'texto removido na anonimizacao do titular';

    UPDATE public.marketplace_attributions
       SET contested_reason = NULL
     WHERE customer_id = NEW.id AND tenant_id = NEW.tenant_id
       AND contested_reason IS NOT NULL;
  END IF;
  RETURN NEW;
END $$;
