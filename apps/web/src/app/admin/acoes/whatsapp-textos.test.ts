import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ submeterTemplateNaApi: vi.fn() }));
vi.mock('@/lib/admin-api', () => api);
vi.mock('@/lib/sessao-gestor', () => ({ lerSessaoGestor: async () => 'sessao-sintetica', guardarMotivoDaMeta: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: (rota: string) => { throw new Error('redirect:'+rota); } }));
import { acaoSubmeterTemplate } from './crescimento-plataforma';

beforeEach(() => api.submeterTemplateNaApi.mockReset().mockResolvedValue({ ok: true }));
describe('escolha de botões na mensagem Meta', () => {
  it.each([[], ['confirmar'], ['confirmar', 'cancelar']])('preserva exatamente os botões escolhidos: %j', async (...selecionados: string[]) => {
    const form = new FormData();
    form.set('titulo', 'Meu lembrete'); form.set('tipo', 'lembrete_24h'); form.set('corpo', 'Seu horário é amanhã.');
    for (const botao of selecionados) form.append('botoes', botao);
    await expect(acaoSubmeterTemplate(form)).rejects.toThrow('redirect:/admin/whatsapp?feito=template');
    expect(api.submeterTemplateNaApi).toHaveBeenCalledWith('sessao-sintetica', expect.objectContaining({ botoes: selecionados }));
  });
});
