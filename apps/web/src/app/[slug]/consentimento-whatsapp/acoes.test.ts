import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  lerPedidoConsentimentoCadastro: vi.fn(),
  confirmarConsentimentoCadastroNaApi: vi.fn(),
  esquecerConsentimentoCadastro: vi.fn(),
}));
vi.mock('@/lib/consentimento-cadastro', () => api);
vi.mock('@/lib/sessao', () => ({ lerSessao: async () => 'sessao-sintetica' }));
vi.mock('next/navigation', () => ({ redirect: (rota: string) => { throw new Error('redirect:' + rota); } }));
import { confirmarAceiteCadastro } from './acoes';

const formulario = () => { const f = new FormData(); f.set('slug', 'barbearia'); return f; };
beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  api.lerPedidoConsentimentoCadastro.mockResolvedValue({ token: 'intencao-sintetica', appointmentId: 'horario' });
});

describe('retorno da confirmação de novidades por WhatsApp', () => {
  it('anuncia ativação somente quando a API acabou de registrar o aceite', async () => {
    api.confirmarConsentimentoCadastroNaApi.mockResolvedValue({ ok: true, dados: { confirmado: true, novoAceite: true } });
    await expect(confirmarAceiteCadastro(formulario())).rejects.toThrow('redirect:/barbearia/meus-agendamentos?feito=aceitou');
    expect(api.confirmarConsentimentoCadastroNaApi).toHaveBeenCalledWith('barbearia', 'sessao-sintetica', 'intencao-sintetica');
    expect(api.esquecerConsentimentoCadastro).toHaveBeenCalledWith('barbearia');
  });
  it('uma resposta repetida preserva as preferências atuais sem anunciar ativação', async () => {
    api.confirmarConsentimentoCadastroNaApi.mockResolvedValue({ ok: true, dados: { confirmado: true, novoAceite: false } });
    await expect(confirmarAceiteCadastro(formulario())).rejects.toThrow('redirect:/barbearia/meus-agendamentos?feito=aceite_anterior');
    expect(api.esquecerConsentimentoCadastro).toHaveBeenCalledWith('barbearia');
  });
  it('falha não anuncia aceite nem apaga a intenção necessária à nova tentativa', async () => {
    api.confirmarConsentimentoCadastroNaApi.mockResolvedValue({ ok: false, message: 'Tente novamente.' });
    await expect(confirmarAceiteCadastro(formulario())).rejects.toThrow('redirect:/barbearia/consentimento-whatsapp?erro=1');
    expect(api.esquecerConsentimentoCadastro).not.toHaveBeenCalled();
  });
});
