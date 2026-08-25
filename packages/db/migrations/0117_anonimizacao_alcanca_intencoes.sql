-- Anonimização alcança as intenções de envio.
--
-- `whatsapp_manual_send_intents` e `notification_send_intents` nasceram com
-- `customer_id` e ficaram fora de `anonimizar_cliente`: a pessoa exercia o
-- direito à exclusão e as linhas continuavam lá, com o vínculo intacto. A
-- função é lista escrita, e a varredura de catálogo do bloco 34 só olha colunas
-- de `customers` — nenhuma das duas redes pegava isto sozinha.
--
-- Reaplicável: `CREATE OR REPLACE` já é, e nada mais é criado aqui.

CREATE OR REPLACE FUNCTION anonimizar_cliente(p_customer uuid, p_motivo text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant uuid := NULLIF(current_setting('app.tenant_id', true), '')::uuid;
  v_apelido text;
  v_telefone text;
BEGIN
  /**
   * Sem tenant no contexto a função não roda.
   *
   * É a diferença entre "anonimize este cliente da barbearia X" e "anonimize
   * este uuid, onde quer que ele esteja". A segunda seria uma porta para apagar
   * cadastro alheio conhecendo só o id — e `SECURITY DEFINER` a abriria de par
   * em par, porque aqui dentro a RLS pode não estar valendo.
   */
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'anonimizar_cliente exige app.tenant_id no contexto';
  END IF;

  IF length(btrim(coalesce(p_motivo, ''))) < 3 THEN
    RAISE EXCEPTION 'anonimizar_cliente exige motivo escrito';
  END IF;

  -- O `FOR UPDATE` fecha a corrida entre a varredura de retenção e alguém
  -- atendendo o pedido de exclusão pela tela no mesmo instante: a segunda
  -- transação espera, relê `anonymized_at` preenchido e devolve `false`.
  -- O telefone é lido **antes** de ser apagado: ele é a chave de
  -- `otp_challenges`, e sem guardá-lo aqui não haveria como limpar aquela linha
  -- depois.
  SELECT phone_e164 INTO v_telefone
    FROM public.customers
   WHERE id = p_customer AND tenant_id = v_tenant AND anonymized_at IS NULL
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  v_apelido := 'cliente_anonimizado_' || substring(replace(p_customer::text, '-', '') from 1 for 4);

  UPDATE public.customers
     SET name = v_apelido,
         phone_e164 = NULL,
         birth_date = NULL,
         accepts_marketing = false,
         marketing_consent_ip = NULL,
         -- O par do IP, e ele ficava para trás. A invariante de catálogo que
         -- este bloco criou foi quem o encontrou: `accepts_marketing` já virava
         -- `false`, então o carimbo dizia "esta pessoa consentiu às 14h22" sobre
         -- um consentimento que não vale mais. A prova de verdade é o histórico
         -- append-only de `customer_consents`, que continua intacto — isto aqui
         -- é espelho derivado, e espelho de dado apagado é dado apagado.
         marketing_consent_at = NULL,
         marketing_consent_version = NULL,
         -- Bloco 37. O motivo do override é texto livre escrito por um gerente
         -- **sobre uma pessoa**, e os exemplos deste repositório são "faltou
         -- por internação" e "sumiu com a chave da barbearia": dado de saúde e
         -- imputação de crime. Sobreviver à anonimização faria a função apagar
         -- o nome e guardar a narrativa — com carimbo de hora, que sozinho já
         -- reidentifica. Achado da `/security-review` do bloco 37, e é o mesmo
         -- defeito que `otp_challenges` teve no bloco 32.
         reliability_override = NULL,
         reliability_override_reason = NULL,
         reliability_override_at = NULL,
         /**
          * Bloco 54. O CPF do tomador, que a nota fiscal usa.
          *
          * É o identificador mais direto que existe no cadastro: deixá-lo para
          * trás faria a função apagar nome e telefone e guardar exatamente o
          * número pelo qual a pessoa é encontrada em qualquer outra base.
          */
         tax_id = NULL,
         anonymized_at = now(),
         updated_at = now()
   WHERE id = p_customer AND tenant_id = v_tenant;

  UPDATE public.customer_consents
     SET ip = NULL
   WHERE customer_id = p_customer AND tenant_id = v_tenant;

  UPDATE public.customer_ledger
     SET note = NULL
   WHERE customer_id = p_customer AND tenant_id = v_tenant;

  UPDATE public.customer_preferences
     SET maquina_laterais = NULL, tipo_degrade = NULL, topo = NULL,
         barba_estilo = NULL, produtos_evitar = NULL, observacoes = NULL,
         updated_at = now()
   WHERE customer_id = p_customer AND tenant_id = v_tenant;

  UPDATE public.queue_entries
     SET notes = NULL
   WHERE customer_id = p_customer AND tenant_id = v_tenant;

  /**
   * A lista de espera fecha junto (bloco 38).
   *
   * Não é dado pessoal — são datas, uma faixa de horas e uma duração —, e por
   * isso a linha fica. O que não pode ficar é o estado **vivo**: uma entrada
   * `waiting` continuaria concorrendo a toda vaga que abrisse, e o balcão veria
   * "cliente_anonimizado_a3f1" na lista de quem chamar, sem telefone para
   * chamar. A pessoa pediu justamente para sair.
   *
   * Mora aqui e não na camada de cima porque o princípio desta função é ser o
   * caminho **único**: quem chamar o SQL direto — a varredura de retenção, uma
   * correção manual — também precisa fechar a lista.
   */
  UPDATE public.waitlist_entries
     SET status = 'left', closed_at = now(), updated_at = now()
   WHERE customer_id = p_customer AND tenant_id = v_tenant AND status = 'waiting';

  UPDATE public.appointments
     SET notes = NULL
   WHERE customer_id = p_customer AND tenant_id = v_tenant;

  UPDATE public.notifications
     SET phone_masked = NULL
   WHERE customer_id = p_customer AND tenant_id = v_tenant;

  /**
   * A sessão do navegador é credencial viva, não histórico.
   *
   * Apagada e não revogada: revogar deixaria `ip` e `user_agent` na tabela, que
   * são dado pessoal, e a linha não serve para nada depois disso — a trilha do
   * que essa pessoa fez está em `appointments` e `orders`.
   */
  DELETE FROM public.customer_sessions
   WHERE customer_id = p_customer AND tenant_id = v_tenant;

  /**
   * O desafio de OTP daquele número, inteiro.
   *
   * A tabela guarda o telefone em claro e o nome pendente, e `verifyOtp`
   * reaproveita o nome ao criar o cadastro. Deixá-la faria a pessoa entrar de
   * novo com o número antigo e reaparecer com o **nome verdadeiro**.
   */
  /**
   * A nota fiscal guarda nome e CPF do tomador, e os dois são cópia do
   * cadastro — como `queue_entries.customer_name`, que já é limpa acima.
   *
   * O que **não** sai é o valor, o número e a data: eles são o registro fiscal,
   * a barbearia tem obrigação de guarda de cinco anos, e é a mesma decisão que
   * mantém a venda de pé. Anonimizar é tirar a pessoa de dentro do documento,
   * não destruir o documento.
   *
   * O filtro passa por `orders` porque a nota aponta para a venda, não para o
   * cliente — e é sob o tenant, porque `SECURITY DEFINER` roda como dono e a
   * RLS pode não estar valendo aqui dentro.
   */
  UPDATE public.fiscal_invoices
     SET customer_name = v_apelido,
         customer_document = NULL
   WHERE tenant_id = v_tenant
     AND order_id IN (
       SELECT id FROM public.orders
        WHERE tenant_id = v_tenant AND customer_id = p_customer
     );

  /**
   * O que o cliente escreveu pelo WhatsApp, e o número de onde escreveu.
   *
   * `whatsapp_inbound` guarda o telefone em claro — é ele que identifica quem
   * respondeu, porque a Meta não devolve o nosso id — e o texto que a pessoa
   * digitou, que rotineiramente traz o nome dela. Os dois são cópia de dado
   * pessoal fora de `customers`, e a função é uma **lista escrita**: coluna
   * nova que não entra aqui sobrevive à anonimização em silêncio.
   *
   * A linha fica, sem a pessoa: ela é o registro de que houve uma conversa, e
   * é o mesmo critério de `queue_entries` e da nota fiscal. O que sai é quem.
   */
  UPDATE public.whatsapp_inbound
     SET from_phone = NULL, body = NULL, customer_id = NULL
   WHERE tenant_id = v_tenant AND customer_id = p_customer;

  IF v_telefone IS NOT NULL THEN
    DELETE FROM public.otp_challenges
     WHERE tenant_id = v_tenant AND phone_e164 = v_telefone;
  END IF;

  /**
   * O recado perde o dono e continua existindo (bloco 40).
   *
   * As duas coisas são verdadeiras ao mesmo tempo: a pessoa tem direito a sair,
   * e a barbearia precisa continuar sabendo que a cadeira do fundo está bamba.
   * Apagar perderia a melhoria — e nem seria possível, porque a tabela não tem
   * `DELETE` para a aplicação. Manter o vínculo manteria a pessoa identificada
   * por um texto que ela mesma escreveu, e que pode dizer o nome dela.
   *
   * O que se desata é o vínculo. O texto fica órfão, e é o que se quer.
   */
  UPDATE public.feedbacks
     SET customer_id = NULL, updated_at = now()
   WHERE customer_id = p_customer AND tenant_id = v_tenant;

  /**
   * A avaliação perde o autor e o texto, e a nota fica (bloco 43).
   *
   * A nota é fato do negócio: a média da casa e o indicador do barbeiro foram
   * calculados com ela, e apagá-la reescreveria a história do trabalho de outra
   * pessoa — que não pediu para sair de lugar nenhum. O comentário sai junto do
   * vínculo porque é texto livre, e é onde a pessoa pode ter escrito o próprio
   * nome.
   *
   * É a mesma decisão do razão do cliente: a linha e os números ficam, a pessoa
   * sai de dentro deles. E o gatilho de imutabilidade não atrapalha: esta função
   * roda como dona da tabela, e o gatilho recusaria a mudança do comentário.
   */
  ALTER TABLE public.reviews DISABLE TRIGGER reviews_nota_imutavel;
  UPDATE public.reviews
     SET customer_id = NULL, comment = NULL
   WHERE customer_id = p_customer AND tenant_id = v_tenant;
  ALTER TABLE public.reviews ENABLE TRIGGER reviews_nota_imutavel;

  /**
   * A assinatura de quem saiu é cancelada (bloco 45).
   *
   * Ela não pode ficar viva: uma assinatura `ativa` continuaria contando no MRR
   * e dando cota de corte a um cadastro que a pessoa pediu para apagar — e a
   * cobrança recorrente do bloco 47 tentaria cobrar um cartão de alguém que não
   * é mais cliente.
   *
   * O **uso** fica, com o vínculo intacto: ele é fato do negócio, e a
   * rentabilidade do plano foi calculada com ele. Quem sai de dentro dele é o
   * cliente, pela chave estrangeira da assinatura.
   */
  UPDATE public.club_subscriptions
     SET status = 'cancelada', cancelled_at = now(),
         cancel_reason = 'anonimizacao do titular',
         /**
          * O cartão salvo sai junto, e é o conserto de um buraco de verdade.
          *
          * O comentário acima já dizia o que aconteceria — "a cobrança
          * recorrente do bloco 47 tentaria cobrar um cartão de alguém que não é
          * mais cliente" — e o bloco 47 criou as colunas sem fechar a ponta.
          * Achado da `/security-review`: a fatura já emitida continuava em
          * aberto, e a régua da madrugada apresentaria o token ao adquirente por
          * mais quinze dias. Sem ninguém saber, porque o telefone já foi apagado
          * e o aviso não teria para onde ir.
          *
          * Credencial de pagamento é como token de sessão: some com a pessoa.
          */
         payment_token = NULL, card_brand = NULL, card_last4 = NULL,
         card_exp_month = NULL, card_exp_year = NULL, card_warned_at = NULL,
         updated_at = now()
   WHERE customer_id = p_customer AND tenant_id = v_tenant AND status <> 'cancelada';

  /**
   * A foto do rosto da pessoa sai, e é `DELETE` (bloco 74).
   *
   * Esta função é **lista escrita**, não varredura: coluna ou tabela nova que
   * não entre aqui sobrevive à anonimização em silêncio. O bloco 74 criou
   * `customer_photos` e quase repetiu o defeito — e o efeito seria o pior deste
   * produto: quem exerceu o direito à exclusão continuaria com o rosto numa
   * página **indexada**, porque a anonimização não insere revogação de
   * consentimento e o gatilho que apaga por revogação nunca dispararia.
   *
   * `DELETE` e não `in_portfolio = false`: a foto **é** a pessoa. Não é registro
   * de fato do negócio como a venda ou a nota — é o mesmo critério de
   * `customer_sessions`, que também some inteira.
   *
   * Achado da `/security-review` do bloco 74.
   */
  DELETE FROM public.customer_photos
   WHERE customer_id = p_customer AND tenant_id = v_tenant;

  /**
   * As intenções de envio daquela pessoa, inteiras.
   *
   * Elas existem para impedir mandar a mesma mensagem duas vezes, e guardam
   * `customer_id` para deduplicar por pessoa e por dia. Não são registro de
   * dinheiro nem tabela append-only: são estado operacional preso a alguém, o
   * mesmo caso de `customer_sessions`. Depois da anonimização não há para quem
   * reenviar — o telefone saiu do cadastro —, então a linha não protege mais
   * nada e o que ela faz é sobreviver ao direito à exclusão.
   */
  DELETE FROM public.whatsapp_manual_send_intents
   WHERE customer_id = p_customer AND tenant_id = v_tenant;

  DELETE FROM public.notification_send_intents
   WHERE customer_id = p_customer AND tenant_id = v_tenant;

  RETURN true;
END $$;
