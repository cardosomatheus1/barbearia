-- ============================================================================
-- 0070 — o perfil público do barbeiro (bloco 73, SPEC §5.2)
--
-- > ### Perfil público do barbeiro (opcional, por profissional)
-- > ```
-- > João Silva                    ⭐ 4,92 · 1.842 atendimentos
-- > Especialidades: fade · degradê · barba · corte social
-- > [ portfólio ]  [ horários ]  [ Agendar com João ]
-- > ```
--
-- ## "Opcional, por profissional" é a frase inteira, e ela decide o padrão
--
-- Nasce **desligado**, e é a exceção consciente à regra do bloco 60 — ali,
-- "regra que beneficia nasce ligada". Aparecer numa página indexada com nome,
-- foto, nota e contagem de atendimentos não é um benefício que a barbearia
-- concede: é exposição pública de uma **pessoa**, e a SPEC escreve "opcional"
-- justamente porque a decisão é de quem vai aparecer. Ligado por padrão, o
-- barbeiro descobriria o próprio perfil pelo Google.
--
-- É a mesma leitura do consentimento de foto do cliente no bloco 31: o produto
-- não publica gente por omissão.
-- ============================================================================

ALTER TABLE professionals
  /**
   * Se este profissional tem página pública.
   *
   * Desligado por padrão — ver o cabeçalho. Quem liga é a barbearia pela tela
   * de equipe, e a página só existe enquanto o profissional estiver ativo e
   * vendável online: um perfil no ar para quem saiu da casa é o pior link que
   * o produto pode ter.
   */
  ADD COLUMN public_profile boolean NOT NULL DEFAULT false,

  /**
   * O endereço público, dentro do da barbearia: `/{slug}/b/{public_slug}`.
   *
   * Único **por barbearia** e não global: dois "joao" em cidades diferentes são
   * duas pessoas legítimas, e um índice global faria a segunda barbearia
   * descobrir que a primeira existe — além de transformar cadastro de equipe
   * numa corrida por nome.
   *
   * Permanente como o slug da casa: renomear troca o endereço de uma página
   * indexada, e o link que o cliente salvou morre. A tela não oferece troca.
   */
  ADD COLUMN public_slug text,

  /**
   * As especialidades, de lista fechada.
   *
   * Texto livre aqui produziria "fade", "Fade", "degrade" e "degradê" como
   * quatro coisas diferentes — e o filtro por especialidade, que é o passo
   * seguinte no marketplace, nasceria impossível. É a mesma decisão de
   * `locations.amenities` no bloco 7, e a lista mora em `packages/core`.
   */
  ADD COLUMN specialties text[] NOT NULL DEFAULT '{}',

  ADD CONSTRAINT professionals_slug_publico_formato
    CHECK (public_slug IS NULL OR public_slug ~ '^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$'),

  /**
   * Perfil ligado exige endereço. Sem isto, "ligado" seria um estado que não
   * produz página nenhuma — a barbearia liga, procura o link e não acha.
   */
  ADD CONSTRAINT professionals_perfil_publico_tem_slug
    CHECK (NOT public_profile OR public_slug IS NOT NULL);

CREATE UNIQUE INDEX professionals_slug_publico
  ON professionals (tenant_id, public_slug) WHERE public_slug IS NOT NULL;

COMMENT ON COLUMN professionals.public_profile IS
  'Se este profissional tem página pública (bloco 73, SPEC §5.2). Nasce '
  'desligado: expor nome, foto e nota de uma pessoa numa página indexada é '
  'decisão dela, não padrão do produto.';

COMMENT ON COLUMN professionals.specialties IS
  'Especialidades de lista fechada (bloco 73). Texto livre faria "fade" e '
  '"Fade" virarem duas coisas, e o filtro por especialidade nasceria impossível.';
