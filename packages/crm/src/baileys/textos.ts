import { randomUUID } from 'node:crypto';
import { withTenant } from '@barbearia/db';
import { audit } from '@barbearia/identity';
import { TIPOS_DE_NOTIFICACAO, VARIAVEIS_DO_AVISO, naturezaDe, type TipoDeNotificacao } from '@barbearia/core';
import { BaileysError, canalDaUnidade, type AtorBaileys, type EscopoBaileys } from './sessao.js';

export interface TextoBaileys {
  id: string; titulo: string; tipo: TipoDeNotificacao; corpo: string; habilitado: boolean;
}
export function validarCorpoBaileys(tipo: TipoDeNotificacao, corpo: string): boolean {
  // Autenticação usa o canal da plataforma, separado do número da unidade.
  if (tipo === 'senha_de_acesso' || !TIPOS_DE_NOTIFICACAO.includes(tipo) || corpo.trim().length < 5 || corpo.length > 3500) return false;
  for (const match of corpo.matchAll(/\{\{([^{}]*)\}\}/g)) {
    const posicao = match[1]?.trim() ?? '';
    if (!/^[1-9][0-9]*$/.test(posicao) || Number(posicao) > VARIAVEIS_DO_AVISO[tipo].length) return false;
  }
  return !corpo.replace(/\{\{[^{}]*\}\}/g, '').includes('{{');
}
export async function salvarTextoBaileys(p: AtorBaileys & { texto: Omit<TextoBaileys, 'id'> & { id?: string } }): Promise<{ id: string }> {
  const t = p.texto;
  if (!t.titulo.trim() || t.titulo.length > 80 || !validarCorpoBaileys(t.tipo, t.corpo)) {
    throw new BaileysError('baileys_texto_invalido', 'Confira o título, o texto e as variáveis deste aviso.', 400);
  }
  return withTenant(p.tenantId, async tx => {
    const [ator] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM staff_users WHERE id = ${p.staffId}::uuid AND active`;
    const [local] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM locations WHERE id = ${p.locationId}::uuid`;
    if (!ator || !local) throw new BaileysError('baileys_nao_permitido', 'Não foi possível alterar esta mensagem.', 403);
    const id = t.id ?? randomUUID();
    if (t.id) {
      const [atual] = await tx.$queryRaw<{ kind: string }[]>`SELECT kind::text FROM whatsapp_templates
        WHERE id = ${id}::uuid AND location_id = ${p.locationId}::uuid AND transport = 'baileys' FOR UPDATE`;
      if (!atual) throw new BaileysError('baileys_texto_ausente', 'Esta mensagem não está disponível.', 404);
      // Alterar o tipo mudaria opt-out, variáveis e finalidade de campanhas existentes.
      if (atual.kind !== t.tipo) throw new BaileysError('baileys_tipo_do_texto', 'Crie outra mensagem para mudar a finalidade.', 400);
      await tx.$executeRaw`UPDATE whatsapp_templates SET titulo = ${t.titulo.trim()}, body = ${t.corpo.trim()},
        local_enabled = ${t.habilitado}, updated_at = now() WHERE id = ${id}::uuid`;
    } else {
      await tx.$executeRaw`INSERT INTO whatsapp_templates (id, tenant_id, location_id, kind, name, titulo, body, transport, local_enabled)
        VALUES (${id}::uuid, ${p.tenantId}::uuid, ${p.locationId}::uuid, ${t.tipo}::notification_kind,
          ${`local_${id.replaceAll('-', '')}`}, ${t.titulo.trim()}, ${t.corpo.trim()}, 'baileys', ${t.habilitado})`;
    }
    await audit(tx, { actorId: p.staffId, actorName: p.staffName, action: 'whatsapp.local_text_changed',
      entity: 'whatsapp_template', entityId: id, after: { tipo: t.tipo, habilitado: t.habilitado } });
    return { id };
  });
}

export async function textoBaileysParaEnvio(p: EscopoBaileys & {
  tipo: TipoDeNotificacao; promocional?: boolean; templateId?: string | null; variaveis: readonly string[]; appointmentId?: string | null;
}): Promise<{ texto: string; templateId: string }> {
  return withTenant(p.tenantId, async tx => {
    if (await canalDaUnidade(p, tx) !== 'baileys') throw new BaileysError('canal_divergente', 'O canal da unidade foi alterado.');
    const [t] = await tx.$queryRaw<{ id: string; body: string; kind: TipoDeNotificacao }[]>`SELECT id, body, kind::text FROM whatsapp_templates
      WHERE location_id = ${p.locationId}::uuid AND transport = 'baileys' AND local_enabled AND kind = ${p.tipo}::notification_kind
        AND (${p.templateId ?? null}::uuid IS NULL OR id = ${p.templateId ?? null}::uuid)
      ORDER BY created_at DESC, id DESC LIMIT 1`;
    if (!t) throw new BaileysError('baileys_texto_indisponivel', 'Cadastre ou habilite uma mensagem para este aviso na conexão por QR.');
    let texto = t.body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_match, posicao: string) => {
      const valor = p.variaveis[Number(posicao) - 1];
      if (valor === undefined || valor === '') throw new BaileysError('baileys_variavel_ausente', 'Faltam dados para montar este aviso.');
      return valor;
    });
    if (p.promocional || naturezaDe(p.tipo) === 'promocional') texto += '\n\nPara sair das promoções, responda PARAR.';
    if (p.appointmentId) texto += '\n\nUse Responder neste aviso e escreva CONFIRMAR ou CANCELAR para alterar este horário.';
    if (texto.length > 4096) throw new BaileysError('baileys_mensagem_grande', 'Reduza o texto desta mensagem.', 400);
    return { texto, templateId: t.id };
  });
}
