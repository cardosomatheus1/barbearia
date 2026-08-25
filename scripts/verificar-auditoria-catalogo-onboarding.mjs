import fs from 'node:fs';

const ler = (p) => fs.readFileSync(p, 'utf8');
const falhas = [];
const exigir = (ok, mensagem) => { if (!ok) falhas.push(mensagem); };

const concorrencia = ler('packages/catalog/src/concorrencia.ts');
const unidades = ler('packages/catalog/src/unidades.ts');
const recursos = ler('packages/catalog/src/recursos.ts');
const servicos = ler('packages/catalog/src/servicos.ts');
const validador = ler('packages/catalog/src/validador.ts');
const equipe = ler('packages/catalog/src/equipe.ts');
const schedConcorrencia = ler('packages/scheduling/src/concorrencia.ts');
const booking = ler('packages/scheduling/src/booking.ts');
const franquia = ler('packages/catalog/src/franquia.ts');
const onboarding = ler('packages/onboarding/src/onboarding.ts');
const schemas = ler('apps/api/src/admin/admin.schemas.ts');
const catalogSchemas = ler('apps/api/src/admin/catalogo.schemas.ts');
const multiSchemas = ler('apps/api/src/admin/multiunidade.schemas.ts');
const multiController = ler('apps/api/src/admin/multiunidade.controller.ts');
const admin = ler('apps/api/src/admin/admin.controller.ts');
const catalogController = ler('apps/api/src/admin/catalogo.controller.ts');
const webApi = ler('apps/web/src/lib/admin-api/crescimento.ts');
const webAction = ler('apps/web/src/app/admin/acoes/crescimento-plataforma.ts');
const unidadesPage = ler('apps/web/src/app/admin/unidades/page.tsx');
const migracao = ler('packages/db/migrations/0114_catalogo_estrutura_onboarding.sql');
const testeSql = ler('packages/db/test/0114_catalogo_estrutura_onboarding.test.sql');

// Unidade e invariantes multi-linha.
exigir(concorrencia.includes('pg_advisory_xact_lock') && concorrencia.includes('barberdock:catalog:'),
  'catálogo perdeu advisory lock por tenant');
exigir(unidades.includes("travarCatalogoDoTenant(tx, 'locations-active')")
  && unidades.indexOf("travarCatalogoDoTenant(tx, 'locations-active')") < unidades.indexOf('SELECT count(*) AS total FROM locations WHERE active'),
  'última unidade voltou a ser decidida sem serialização do tenant');
exigir(unidades.includes('fusoConhecido(request.timezone)')
  && multiSchemas.includes("estado: z.string().trim().length(2")
  && multiSchemas.includes('linkDoMapa: z.string().trim().max(500)')
  && multiController.includes('estado: body.estado ?? null')
  && multiController.includes('linkDoMapa: body.linkDoMapa ?? null')
  && webApi.includes('estado?: string | null; linkDoMapa?: string | null')
  && webAction.includes("const estado = texto(form, 'estado')")
  && webAction.includes("const linkDoMapa = texto(form, 'linkDoMapa')")
  && unidadesPage.includes('name="estado"') && unidadesPage.includes('name="linkDoMapa"'),
  'cadastro da nova unidade perdeu fuso/UF/mapa em alguma camada do fluxo');
exigir(unidades.includes("Caixa · ${nome} · ${criada.id.slice(0, 8)}"),
  'duas unidades homônimas voltaram a disputar o mesmo nome de gaveta');

// Onboarding de empresa e equipe.
exigir(schemas.includes("refine(fusoConhecido, 'fuso desconhecido').optional()"),
  'cadastro inicial voltou a aceitar timezone arbitrário');
exigir(onboarding.includes('name = CASE WHEN (SELECT count(*) FROM locations) = 1')
  && onboarding.includes('amenities = CASE WHEN ${input.amenities === undefined}::boolean'),
  'saveBusiness voltou a renomear filial ou apagar amenities omitidas');
exigir(admin.includes('selecao.atual?.id ?? selecao.disponiveis.find((u) => u.ativa)?.id'),
  'estado tolerante voltou a cair numa unidade fora do escopo do operador');
exigir(admin.includes('const local = await unidadeDoBalcao(staff);\n      return await saveProfessionals')
  && onboarding.includes("WHERE kind = 'professional' AND location_id = ${locationId}::uuid")
  && onboarding.includes('O serviço "${nome}" atribuído a "${pessoa.name}" não existe.'),
  'gravação da equipe voltou a cair na unidade antiga, atravessar filiais ou descartar skill desconhecida');
exigir(onboarding.includes('SELECT published_at FROM tenants LIMIT 1 FOR UPDATE')
  && onboarding.includes('FOR UPDATE OF t')
  && onboarding.includes('JOIN locations l ON l.id = p.location_id'),
  'publish e replace do onboarding perderam lock comum/revalidação dentro da transação');
exigir(onboarding.includes('validarEstruturaDoCatalogoInicial(services)')
  && schemas.includes('chave de serviço repetida')
  && schemas.includes('nome de serviço repetido')
  && schemas.includes('combo repete componente'),
  'catálogo inicial voltou a aceitar identidade ambígua de serviço/combo');

// Configuração por unidade e PATCH sem apagamento colateral.
exigir(onboarding.includes('cancellation_policy = CASE WHEN ${input.cancellationPolicy === undefined}::boolean')
  && onboarding.includes('CASE WHEN ${nome === undefined}::boolean THEN dpo_name')
  && onboarding.includes('CASE WHEN ${email === undefined}::boolean THEN dpo_email'),
  'políticas opcionais voltaram a apagar valores omitidos');
exigir(onboarding.includes('getPolicies(tenantId: string, locationId: string)')
  && onboarding.includes('WHERE l.id = ${locationId}::uuid')
  && admin.includes('getPolicies(staff.tenantId, local.id)'),
  'GET de políticas voltou a ler a unidade mais antiga');

// Recursos: requisito é global, pool é local; os dois caminhos compartilham lock.
const locksRecursos = recursos.match(/travarCatalogoDoTenant\(tx, 'resources'\)/g)?.length ?? 0;
exigir(locksRecursos >= 2
  && recursos.includes('SELECT id FROM locations WHERE id = ${params.locationId}::uuid AND active')
  && recursos.includes('Cada tipo de recurso deve aparecer uma única vez.')
  && recursos.includes('Cada recurso deve aparecer uma única vez no serviço.'),
  'recursos perderam serialização, validação de unidade ou unicidade da entrada');

// Combo: identidade estável é service id, nunca label.
exigir(servicos.includes('WHERE sc.sold_as_service_id = s.id')
  && servicos.includes('DELETE FROM service_combos WHERE sold_as_service_id = ${serviceId}::uuid')
  && servicos.includes('tolerance_minutes, sold_as_service_id)')
  && !servicos.includes('DELETE FROM service_combos WHERE name = ${anterior.name}')
  && validador.includes('WHERE s.id = sc.sold_as_service_id')
  && !validador.includes('WHERE s.name = sc.name'),
  'combo diário/validador voltou a casar por nome editável');
exigir(servicos.includes('if (input.componentIds?.includes(serviceId))')
  && servicos.includes("throw new CatalogError('invalid_catalog', 'Um combo não pode conter ele mesmo.')")
  && catalogSchemas.includes('Combo precisa de pelo menos dois componentes.')
  && catalogSchemas.includes('Combo não pode repetir componente.'),
  'combo diário voltou a aceitar auto-referência, componente único ou repetido');
exigir(migracao.includes('servicos_para_combo = 1')
  && migracao.includes('combos_para_servico = 1')
  && migracao.includes('service_combos_um_por_servico_vendido')
  && migracao.includes('(tenant_id, sold_as_service_id)'),
  'migração 0114 não faz backfill 1:1 e unicidade do serviço vendido');

// Namespace público e jornada.
exigir(equipe.includes("travarCatalogoDoTenant(tx, 'professional-public-slug')")
  && equipe.indexOf("travarCatalogoDoTenant(tx, 'professional-public-slug')") < equipe.indexOf('slug = await enderecoLivre(tx, base)'),
  'slug público voltou a decidir disponibilidade sem serialização');
exigir(equipe.includes('AND location_id = ${params.locationId}::uuid\n       FOR UPDATE')
  && equipe.includes('Cada dia da semana aceita uma jornada; use breaks para os intervalos.')
  && schemas.includes('dia da semana repetido; use breaks para intervalos')
  && catalogSchemas.includes('Dia da semana repetido; use breaks para intervalos.'),
  'substituição de jornada perdeu lock ou aceita dias repetidos');

// Jornada e Agenda precisam disputar exatamente a mesma trava de profissional.
const locksProfCatalog = equipe.match(/travarConfiguracaoDoProfissional\(tx, params\.professionalId\)/g)?.length ?? 0;
const locksProfScheduling = booking.match(/travarConfiguracaoDoProfissional\(tx, /g)?.length ?? 0;
exigir(concorrencia.includes('barberdock:professional-config:')
  && schedConcorrencia.includes('barberdock:professional-config:')
  && locksProfCatalog >= 2
  && locksProfScheduling >= 3
  && catalogController.includes('return await saveScheduleWithConflicts({'),
  'jornada e Agenda deixaram de compartilhar lock atômico por profissional');

// Alvos e estado por unidade.
exigir(onboarding.includes("if (afetadas === 0) throw new OnboardingError('invalid_catalog', 'Profissional da foto não encontrado nesta unidade.')")
  && onboarding.includes("if (afetadas === 0) throw new OnboardingError('invalid_catalog', 'Serviço da foto não encontrado.')"),
  'foto voltou a reportar sucesso para alvo inexistente');
exigir(onboarding.includes("p.location_id = l.id)\n               AS professionals")
  && onboarding.includes('WHERE p.location_id = l.id) AS schedules'),
  'estado do onboarding voltou a contar equipe/jornada de outra unidade');

// Franquia: conflito legível e adoção sem race de categoria.
exigir(franquia.includes('franchise-service-name:') && franquia.includes("throw new CatalogError('name_taken'")
  && franquia.includes('ON CONFLICT (tenant_id, name) DO UPDATE SET name = EXCLUDED.name'),
  'franquia voltou a expor unique violation em nome/categoria concorrentes');

exigir(testeSql.includes('segundo combo foi ligado ao mesmo serviço vendido')
  && testeSql.includes('renomear serviço perdeu identidade do combo'),
  'prova SQL 0114 não cobre unicidade e renomeação');

if (falhas.length) {
  console.error(`Auditoria Catálogo/Onboarding: ${falhas.length} falha(s)`);
  for (const falha of falhas) console.error(`- ${falha}`);
  process.exit(1);
}
console.log('Auditoria Catálogo/Onboarding: multiunidade, replace, recursos, combos, jornada e franquia preservados');
