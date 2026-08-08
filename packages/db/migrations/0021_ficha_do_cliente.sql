-- ============================================================================
-- 0021 — A ficha do cliente, e a conta do barbeiro
--
-- Duas coisas que já existiam pela metade.
--
-- 1. **`customers.view_notes` é permissão desde o bloco 12 e não havia
--    anotação nenhuma para ver.** O papel `professional` a recebe por padrão, a
--    `PermissaoGuard` a aplica, a recepção é excluída dela de propósito — e
--    atrás de tudo isso não havia coluna. É o mesmo defeito de `blocks`, ao
--    contrário: aqui a permissão é que estava vazia.
--
-- 2. **`staff_users.professional_id` existe desde o bloco 12 e nada o
--    preenchia.** A coluna, a chave estrangeira e o recorte da agenda por
--    profissional estavam prontos; faltava o caminho que liga a cadeira à
--    conta. Sem ele, o barbeiro entrava com a conta do dono ou não entrava.
--
-- A SPEC §4.1 é enfática sobre o que isto vale: "um barbeiro novo atendendo
-- cliente antigo e acertando o corte de primeira é a coisa mais valiosa que
-- este sistema pode entregar".
-- ============================================================================

/**
 * Como o cliente gosta de ser atendido.
 *
 * **Estruturado onde vira filtro, livre onde vira gente.** A SPEC sugere seis
 * campos (§4.1) porque eles respondem perguntas de operação — quantos clientes
 * preferem silêncio, quais produtos evitar ao repor estoque. O texto livre
 * existe ao lado porque nenhuma lista fechada cobre "o redemoinho do lado
 * direito abre para cima".
 *
 * Uma linha por cliente, não histórico: a preferência é o estado atual, e o que
 * mudou fica na trilha de quem mudou. Corte de dois anos atrás não é
 * preferência, é histórico de atendimento — e esse já existe em `appointments`.
 */
CREATE TABLE customer_preferences (
  customer_id     uuid PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- Os seis da SPEC §4.1. Texto, não enum: "máquina 1" e "máquina 0,5" são
  -- vocabulário da casa, e cada barbearia tem o seu. Enum aqui viraria migração
  -- toda vez que alguém inventasse um degradê.
  maquina_laterais text,
  tipo_degrade     text,
  topo             text,
  barba_estilo     text,
  produtos_evitar  text,

  /**
   * O único fechado, e por um motivo: ele muda o comportamento de quem atende,
   * não o corte. "Prefere atendimento silencioso" precisa ser legível de
   * relance, com a mesma palavra sempre — texto livre aqui produziria "quieto",
   * "não gosta de conversa" e "silêncio", e o barbeiro novo leria três coisas
   * diferentes com pressa.
   */
  conversa         text NOT NULL DEFAULT 'indiferente',

  -- O que nenhuma lista fechada cobre.
  observacoes      text,

  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- Quem anotou. O barbeiro que lê "não usar navalha" quer saber de quem veio
  -- antes de confiar — e ninguém confia numa anotação sem dono.
  updated_by       uuid REFERENCES staff_users(id) ON DELETE SET NULL,

  CONSTRAINT customer_preferences_conversa_conhecida
    CHECK (conversa IN ('silencioso', 'indiferente', 'conversa')),

  /**
   * Teto por campo.
   *
   * Anotação é caixa de texto que o barbeiro preenche entre um cliente e outro,
   * e sem teto ela vira o lugar onde alguém cola o histórico inteiro — que a
   * tela então precisa rolar antes de mostrar a informação útil. O limite é
   * generoso e existe para preservar a leitura de relance.
   */
  CONSTRAINT customer_preferences_campos_curtos CHECK (
    length(coalesce(maquina_laterais, '')) <= 120
    AND length(coalesce(tipo_degrade, '')) <= 120
    AND length(coalesce(topo, '')) <= 120
    AND length(coalesce(barba_estilo, '')) <= 120
    AND length(coalesce(produtos_evitar, '')) <= 240
    AND length(coalesce(observacoes, '')) <= 1000
  )
);

ALTER TABLE customer_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer_preferences
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

/**
 * Uma cadeira, uma conta.
 *
 * `staff_users.professional_id` era livre: nada impedia duas contas apontando
 * para o mesmo profissional. Duas pessoas veriam a mesma agenda como "minha", e
 * a comissão do bloco 19 — que sai de `professional_id` — passaria a ter dois
 * donos. `NULLS NOT DISTINCT` fica de fora de propósito: quem não é barbeiro
 * tem a coluna nula, e essas linhas não competem entre si.
 */
CREATE UNIQUE INDEX staff_users_professional_unico
  ON staff_users (professional_id) WHERE professional_id IS NOT NULL;

/**
 * O telefone do profissional, para onde o convite vai.
 *
 * Ele já existia em `staff_users` — mas a conta só nasce **no** convite, e o
 * convite precisa saber para onde mandar antes de existir conta. Sem esta
 * coluna, o dono teria que digitar o telefone de novo a cada reenvio.
 */
ALTER TABLE professionals
  ADD COLUMN phone_e164 text,
  ADD CONSTRAINT professionals_phone_format
    CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{7,14}$');
