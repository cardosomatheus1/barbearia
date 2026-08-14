-- ============================================================================
-- 0075 — API pública: chaves, escopos e teto por chave (bloco 78)
--
-- ## O escopo é uma permissão, não um vocabulário novo
--
-- A tentação óbvia é inventar `read:appointments`, `write:appointments` e uma
-- tabela de-para. Este repositório já pagou por lista paralela cinco vezes —
-- `secoes.ts`, os rótulos de campanha, os públicos de campanha — e o resultado
-- é sempre o mesmo: uma das duas para de ser atualizada, e nada fica vermelho.
--
-- O escopo de uma chave é uma linha de `PERMISSOES`, o mesmo catálogo que a
-- `PermissaoGuard` aplica. Uma permissão nova nasce disponível para a API sem
-- ninguém lembrar dela, e o `CHECK` abaixo cita a mesma lista.
--
-- ## O que a chave **não** pode ter, e por quê
--
-- Nada de `PERMISSOES_DE_DINHEIRO`. O segundo fator deste produto é derivado do
-- prefixo (`finance.`, `cashier.`, mais duas de comissão) e é provado por
-- **sessão**, com TOTP. Uma máquina não digita TOTP: ou a chave seria inútil,
-- ou alguém "resolveria" isentando-a da exigência — e aí a API pública viraria
-- a porta sem segundo fator para o dinheiro que o balcão só move com ele.
--
-- A recusa é em três camadas, como o motivo escrito do estorno: na borda, no
-- domínio e aqui, por `CHECK`.
--
-- ## O segredo não mora aqui
--
-- Guardamos o **prefixo** em claro — é ele que identifica a chave na tela e no
-- log — e o HMAC-SHA256 do segredo com uma chave de ambiente própria
-- (`API_KEY_PEPPER`). É a postura de `staff_directory.email_key`: o banco
-- vazado não entrega credencial viva.
--
-- HMAC e não `scrypt`, e a diferença é o uso: senha é entropia baixa digitada
-- por gente e precisa ser cara de derivar; chave de API é 256 bits sorteados e
-- conferidos a cada requisição — um `scrypt` por chamada seria o teto de vazão
-- da integração inteira.
-- ============================================================================

CREATE TABLE api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  /** Nome que a barbearia dá: "integração do site", "ERP do contador". */
  name          text NOT NULL,

  /**
   * A metade pública da chave, em claro.
   *
   * É por ela que a autenticação encontra a linha — um índice único sobre um
   * HMAC exigiria calcular o HMAC de toda chave da base a cada requisição. E é
   * ela que aparece na tela e no log, porque o segredo não aparece em lugar
   * nenhum depois da criação.
   */
  prefix        text NOT NULL,

  /** HMAC-SHA256 do segredo com `API_KEY_PEPPER`. Nunca o segredo. */
  secret_hmac   text NOT NULL,

  /**
   * As permissões desta chave, do mesmo catálogo que a `PermissaoGuard` aplica.
   *
   * Vazio é chave que não faz nada — recusado: uma chave sem escopo é uma
   * credencial viva que não serve para nada e que ninguém revoga, porque não
   * dá para saber o que ela quebraria.
   */
  scopes        text[] NOT NULL,

  created_by    uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  revoke_reason text,

  CONSTRAINT api_keys_nome_nao_vazio CHECK (length(btrim(name)) >= 2),
  CONSTRAINT api_keys_escopo_nao_vazio CHECK (cardinality(scopes) > 0),
  CONSTRAINT api_keys_revogacao_tem_motivo CHECK (
    (revoked_at IS NULL AND revoke_reason IS NULL)
    OR (revoked_at IS NOT NULL AND length(btrim(coalesce(revoke_reason, ''))) >= 5)
  ),

  /**
   * Dinheiro não entra numa chave de API, e o banco é a terceira camada.
   *
   * A lista é a mesma de `PERMISSOES_DE_DINHEIRO`: o prefixo `finance.`, o
   * prefixo `cashier.` e as duas de comissão que revelam ou mudam a folha.
   * Escrita aqui porque `CHECK` não chama código — e por isso há teste que
   * deriva do catálogo e reprova quando as duas divergirem.
   *
   * Sem subconsulta, porque `CHECK` não aceita uma: o prefixo é conferido por
   * expressão regular sobre os escopos juntados por vírgula, e as duas de
   * comissão por interseção de arranjo.
   */
  CONSTRAINT api_keys_sem_dinheiro CHECK (
    NOT (scopes && ARRAY['commission.view_all', 'commission.edit_rules']::text[])
    AND array_to_string(scopes, ',') !~ '(^|,)(finance|cashier)\.'
  )
);

CREATE UNIQUE INDEX api_keys_prefixo ON api_keys (prefix);
CREATE INDEX api_keys_da_casa ON api_keys (tenant_id) WHERE revoked_at IS NULL;

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;

/**
 * Leitura com **ou sem** tenant; escrita só de dentro da barbearia.
 *
 * A autenticação da API pública acontece **antes** de existir tenant no
 * contexto — descobrir de quem é a chave é o que ela faz —, e consultar tabela
 * com row security sem tenant devolve zero linhas sempre e em silêncio. É a
 * exceção que `tenant_slugs` já abriu, e a leitura sem tenant alcança só
 * prefixo, HMAC e escopo: não há dado de cliente aqui.
 *
 * A escrita é da barbearia, porque a chave é dela. A plataforma não cria chave
 * para ninguém: seria uma credencial da conta do cliente emitida por fora.
 */
CREATE POLICY api_keys_leitura ON api_keys FOR SELECT USING (
  NULLIF(current_setting('app.tenant_id', true), '') IS NULL
  OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);
CREATE POLICY api_keys_escrita ON api_keys FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

/**
 * Sem `DELETE`: revogar é **estado**, com data e motivo.
 *
 * A chave que rodou seis meses aparece na trilha de auditoria de tudo que ela
 * fez; apagá-la deixaria aquele histórico apontando para nada. É a mesma regra
 * do destaque cancelado e do vale.
 */
GRANT SELECT, INSERT, UPDATE ON api_keys TO barbearia_app;
REVOKE DELETE ON api_keys FROM barbearia_app;

COMMENT ON TABLE api_keys IS
  'Chave de API da barbearia (bloco 78). O escopo e uma permissao do mesmo '
  'catalogo do painel; dinheiro nao entra, porque maquina nao digita TOTP.';

/**
 * O teto por chave, no banco — e portanto compartilhado entre processos.
 *
 * O `ThrottlerModule` conta por IP dentro de **um** processo. Para a API pública
 * isso é o teto errado duas vezes: um integrador atrás de um IP só seria
 * apertado junto com todo mundo daquele NAT, e o mesmo integrador em dois IPs
 * dobraria o limite. Quem gasta a cota é a **chave**.
 *
 * É a forma da escada de login do bloco 33: contador no banco, janela por
 * minuto, e a conferência acontece antes de qualquer trabalho.
 */
CREATE TABLE api_key_usage (
  api_key_id  uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  /** Início do minuto, truncado. Uma linha por chave por minuto. */
  minuto      timestamptz NOT NULL,
  chamadas    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (api_key_id, minuto),
  CONSTRAINT api_key_usage_nao_negativo CHECK (chamadas >= 0)
);

CREATE INDEX api_key_usage_velhas ON api_key_usage (minuto);

ALTER TABLE api_key_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_key_usage FORCE ROW LEVEL SECURITY;
/**
 * `USING (true)`, como `login_attempts`.
 *
 * Não é descuido: a tabela guarda um id, um minuto e um contador. O que ela
 * responde — *"esta chave já gastou a cota do minuto?"* — é perguntado **antes**
 * de existir tenant no contexto, e uma política por `app.tenant_id` devolveria
 * zero linhas sempre, desligando o teto em silêncio.
 */
CREATE POLICY api_key_usage_acesso ON api_key_usage FOR ALL USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON api_key_usage TO barbearia_app;

COMMENT ON TABLE api_key_usage IS
  'Teto por chave e por minuto, no banco para valer entre processos (bloco 78). '
  'Quem gasta a cota e a chave, nao o IP: o integrador atras de um NAT nao '
  'divide teto com estranhos, e em dois IPs nao dobra o dele.';

/**
 * O carimbo de uso, por função — e não por política mais larga.
 *
 * `autenticarChave` roda `semTenant`, porque descobrir de quem é a chave é o que
 * ela faz. A política de escrita de `api_keys` exige tenant no contexto, então o
 * `UPDATE ... SET last_used_at` alcançava **zero linhas**, em silêncio: nenhum
 * erro, o resultado descartado, a coluna nula para sempre — e a tela dizendo
 * "nunca usada" sobre a chave que estava sendo usada naquele instante.
 *
 * É o defeito de `blocks` outra vez, e desta vez com número: a única pista de
 * uso que o produto oferece afirmava o contrário da verdade, justamente na tela
 * em que alguém decide qual chave revogar depois de um vazamento.
 *
 * A alternativa era abrir a escrita sem tenant por política. Não: `USING` e
 * `WITH CHECK` não recortam coluna, e aquilo liberaria também `scopes` e
 * `revoked_at` para qualquer caminho sem tenant. Uma função `SECURITY DEFINER`
 * que só sabe carimbar uma data é a autorização do tamanho exato do que se
 * precisa — e o filtro está escrito dentro, como manda a convenção.
 */
CREATE FUNCTION carimbar_uso_da_chave(p_id uuid, p_agora timestamptz)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE afetadas integer;
BEGIN
  UPDATE public.api_keys SET last_used_at = p_agora
   WHERE id = p_id AND revoked_at IS NULL;
  GET DIAGNOSTICS afetadas = ROW_COUNT;
  RETURN afetadas;
END $$;

COMMENT ON FUNCTION carimbar_uso_da_chave(uuid, timestamptz) IS
  'Carimba last_used_at de uma chave viva. SECURITY DEFINER porque a '
  'autenticacao roda sem tenant no contexto, e a politica de escrita de '
  'api_keys exige um. Ela so sabe escrever uma data.';

REVOKE ALL ON FUNCTION carimbar_uso_da_chave(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION carimbar_uso_da_chave(uuid, timestamptz) TO barbearia_app;
