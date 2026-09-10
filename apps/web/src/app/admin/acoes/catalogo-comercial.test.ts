import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ salvarPacoteNaApi: vi.fn(), salvarPlanoNaApi: vi.fn(), salvarProdutoNaApi: vi.fn() }));
vi.mock('@/lib/admin-api', () => api);
vi.mock('@/lib/sessao-gestor', () => ({ lerSessaoGestor: async () => 'sessao-sintetica', guardarRecusa: vi.fn(), guardarRascunho: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: (rota: string) => { throw new Error('redirect:'+rota); } }));
import { acaoSalvarPacote } from './clientes-conta';
import { acaoSalvarPlano, acaoSalvarProduto } from './produto';

const formulario = (dados: Record<string, string>) => {
  const form = new FormData();
  for (const [k,v] of Object.entries(dados)) form.append(k,v);
  return form;
};
beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset().mockResolvedValue({ ok: true });
});
describe('cadastro comercial recebe os valores que o operador digitou', () => {
  it('pacote lê vírgula decimal e caixas marcadas mesmo depois dos campos ocultos off', async () => {
    const f = formulario({ nome: 'Dois cortes', serviceId: 'servico', quantidade: '2', precoReais: '98,00', validadeDias: '90', ativo: 'off', transferivel: 'off' });
    f.append('ativo','on'); f.append('transferivel','on');
    await expect(acaoSalvarPacote(f)).rejects.toThrow('redirect:/admin/pacotes?salvo=1');
    expect(api.salvarPacoteNaApi).toHaveBeenCalledWith('sessao-sintetica', expect.objectContaining({ precoCents: 9800, ativo: true, transferivel: true }), undefined);
  });
  it('desmarcar pacote e transferência persiste false', async () => {
    const f = formulario({ nome: 'Dois cortes', serviceId: 'servico', quantidade: '2', precoReais: '98.00', ativo: 'off', transferivel: 'off' });
    await expect(acaoSalvarPacote(f)).rejects.toThrow('redirect:/admin/pacotes?salvo=1');
    expect(api.salvarPacoteNaApi).toHaveBeenCalledWith('sessao-sintetica', expect.objectContaining({ precoCents: 9800, ativo: false, transferivel: false }), undefined);
  });
  it.each(['não é preço', '9,999', '-12', 'Infinity'])('recusa preço inválido %s sem chamar a API', async precoReais => {
    await expect(acaoSalvarPacote(formulario({ precoReais }))).rejects.toThrow('erro=valor_invalido');
    expect(api.salvarPacoteNaApi).not.toHaveBeenCalled();
  });
  it('mensalidade do clube aceita reais no formato brasileiro', async () => {
    await expect(acaoSalvarPlano(formulario({ nome: 'Mensal', precoReais: '149,90', descontoPercent: '0' })))
      .rejects.toThrow('redirect:/admin/clube?salvo=1');
    expect(api.salvarPlanoNaApi).toHaveBeenCalledWith('sessao-sintetica', expect.objectContaining({ precoCents: 14990 }), undefined);
  });
  it('estoque usa a mesma conversão para custo e preço sem perder centavos', async () => {
    await expect(acaoSalvarProduto(formulario({ nome: 'Pomada', tipo: 'resale', precoReais: '49,90', custoReais: '12,35' })))
      .rejects.toThrow('redirect:/admin/estoque?salvo=1');
    expect(api.salvarProdutoNaApi).toHaveBeenCalledWith('sessao-sintetica', expect.objectContaining({ precoCents: 4990, custoCents: 1235 }), undefined);
  });
});
