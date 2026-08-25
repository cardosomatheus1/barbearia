import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const raiz = process.cwd();
const arquivos = [
  'packages/catalog/src/concorrencia.ts','packages/catalog/src/unidades.ts','packages/catalog/src/recursos.ts',
  'packages/catalog/src/servicos.ts','packages/catalog/src/validador.ts','packages/catalog/src/equipe.ts','packages/catalog/src/franquia.ts',
  'packages/scheduling/src/concorrencia.ts','packages/scheduling/src/booking.ts',
  'packages/onboarding/src/onboarding.ts','apps/api/src/admin/admin.schemas.ts','apps/api/src/admin/catalogo.schemas.ts','apps/api/src/admin/catalogo.controller.ts',
  'apps/api/src/admin/multiunidade.schemas.ts','apps/api/src/admin/multiunidade.controller.ts',
  'apps/api/src/admin/admin.controller.ts','apps/web/src/lib/admin-api/crescimento.ts',
  'apps/web/src/app/admin/acoes/crescimento-plataforma.ts','apps/web/src/app/admin/unidades/page.tsx',
  'packages/db/migrations/0114_catalogo_estrutura_onboarding.sql',
  'packages/db/test/0114_catalogo_estrutura_onboarding.test.sql','scripts/verificar-auditoria-catalogo-onboarding.mjs',
];

function mutacao(rel, de, para) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'barberdock-catalog-onboarding-'));
  for (const arq of arquivos) {
    const dst = path.join(tmp, arq); fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(raiz, arq), dst);
  }
  const alvo = path.join(tmp, rel); const antes = fs.readFileSync(alvo, 'utf8');
  assert.ok(antes.includes(de), `fixture não contém mutação: ${de.slice(0, 90)}`);
  fs.writeFileSync(alvo, antes.replaceAll(de, para));
  const r = spawnSync(process.execPath, ['scripts/verificar-auditoria-catalogo-onboarding.mjs'], { cwd: tmp, encoding: 'utf8' });
  assert.notEqual(r.status, 0, `guarda aceitou regressão em ${rel}`);
}

test('detecta remoção do lock da última unidade', () => mutacao('packages/catalog/src/unidades.ts', "travarCatalogoDoTenant(tx, 'locations-active')", "lock_locations_removido(tx)"));
test('detecta timezone sem validação de domínio', () => mutacao('packages/catalog/src/unidades.ts', 'fusoConhecido(request.timezone)', 'true'));
test('detecta remoção de estado/mapa da API de unidade', () => mutacao('apps/api/src/admin/multiunidade.controller.ts', 'estado: body.estado ?? null', 'estado: null'));
test('detecta retorno da gaveta baseada só no nome', () => mutacao('packages/catalog/src/unidades.ts', 'Caixa · ${nome} · ${criada.id.slice(0, 8)}', 'Caixa · ${nome}'));
test('detecta business apagando amenities omitidas', () => mutacao('packages/onboarding/src/onboarding.ts', 'amenities = CASE WHEN ${input.amenities === undefined}::boolean', 'amenities = CASE WHEN false'));
test('detecta professionals usando fallback de leitura', () => mutacao('apps/api/src/admin/admin.controller.ts', 'const local = await unidadeDoBalcao(staff);\n      return await saveProfessionals', 'const local = { id: await this.unidadeOuNada(staff) };\n      return await saveProfessionals'));
test('detecta equipe que desativa outras unidades', () => mutacao('packages/onboarding/src/onboarding.ts', "WHERE kind = 'professional' AND location_id = ${locationId}::uuid", "WHERE kind = 'professional'"));
test('detecta replace sem lock do tenant', () => mutacao('packages/onboarding/src/onboarding.ts', 'SELECT published_at FROM tenants LIMIT 1 FOR UPDATE', 'SELECT published_at FROM tenants LIMIT 1'));
test('detecta publish sem row lock', () => mutacao('packages/onboarding/src/onboarding.ts', 'FOR UPDATE OF t', '/* sem lock */'));
test('detecta catálogo inicial sem validação de identidade', () => mutacao('packages/onboarding/src/onboarding.ts', 'validarEstruturaDoCatalogoInicial(services);', '/* validacao removida */'));
test('detecta política opcional que volta a apagar', () => mutacao('packages/onboarding/src/onboarding.ts', 'cancellation_policy = CASE WHEN ${input.cancellationPolicy === undefined}::boolean', 'cancellation_policy = CASE WHEN false'));
test('detecta recursos sem lock compartilhado', () => mutacao('packages/catalog/src/recursos.ts', "travarCatalogoDoTenant(tx, 'resources')", 'lock_recursos_removido(tx)'));
test('detecta combo que volta a casar por nome', () => mutacao('packages/catalog/src/servicos.ts', 'WHERE sc.sold_as_service_id = s.id', 'WHERE sc.name = s.name'));
test('detecta remoção da unicidade sold_as', () => mutacao('packages/db/migrations/0114_catalogo_estrutura_onboarding.sql', 'service_combos_um_por_servico_vendido', 'indice_combo_removido'));
test('detecta slug público sem serialização', () => mutacao('packages/catalog/src/equipe.ts', "travarCatalogoDoTenant(tx, 'professional-public-slug')", 'lock_slug_removido(tx)'));
test('detecta jornada sem lock da cadeira', () => mutacao('packages/catalog/src/equipe.ts', '       FOR UPDATE', '       /* sem lock */'));
test('detecta foto que volta a aceitar alvo inexistente', () => mutacao('packages/onboarding/src/onboarding.ts', "if (afetadas === 0) throw new OnboardingError('invalid_catalog', 'Serviço da foto não encontrado.');", 'if (false && afetadas === 0) throw new Error();'));
test('detecta estado que cruza profissionais entre unidades', () => mutacao('packages/onboarding/src/onboarding.ts', 'AND p.location_id = l.id)', ')'));
test('detecta franquia sem proteção de nome', () => mutacao('packages/catalog/src/franquia.ts', 'franchise-service-name:', 'franchise-name-lock-removido:'));
test('detecta adoção de categoria sem upsert', () => mutacao('packages/catalog/src/franquia.ts', 'ON CONFLICT (tenant_id, name) DO UPDATE SET name = EXCLUDED.name', '/* sem upsert */'));

test('detecta UI que deixa de enviar mapa da nova unidade', () => mutacao('apps/web/src/app/admin/acoes/crescimento-plataforma.ts', "const linkDoMapa = texto(form, 'linkDoMapa');", "const linkDoMapa = '';"));
test('detecta fallback de leitura que ignora unidades autorizadas', () => mutacao('apps/api/src/admin/admin.controller.ts', 'selecao.atual?.id ?? selecao.disponiveis.find((u) => u.ativa)?.id', 'selecao.atual?.id'));
test('detecta combo diário que aceita auto-referência', () => mutacao('packages/catalog/src/servicos.ts', "if (input.componentIds?.includes(serviceId))", 'if (false && input.componentIds?.includes(serviceId))'));

test('detecta validador de combo que volta a casar preço por nome', () => mutacao('packages/catalog/src/validador.ts', 'WHERE s.id = sc.sold_as_service_id', 'WHERE s.name = sc.name'));


test('detecta remoção da trava compartilhada no Scheduling', () => mutacao('packages/scheduling/src/concorrencia.ts', 'barberdock:professional-config:', 'barberdock:scheduling-professional-config:'));
test('detecta criação de agendamento sem trava de configuração', () => mutacao('packages/scheduling/src/booking.ts', 'await travarConfiguracaoDoProfissional(tx, request.professionalId);', 'await Promise.resolve();'));
test('detecta jornada sem trava compartilhada com Agenda', () => mutacao('packages/catalog/src/concorrencia.ts', 'barberdock:professional-config:', 'barberdock:catalog-professional-config:'));
test('detecta controller que volta a separar conferência e gravação da jornada', () => mutacao('apps/api/src/admin/catalogo.controller.ts', 'return await saveScheduleWithConflicts({', 'return await saveScheduleSeparado({'));
