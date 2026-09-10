import type { SituacaoNfseNaTela } from '@/lib/admin-api';
import { acaoSalvarCertificadoNfse, acaoRemoverCertificadoNfse } from '../acoes';

export function CertificadoFiscal({ certificado, emissor = 'nacional' }: { readonly certificado: SituacaoNfseNaTela['certificado']; readonly emissor?: 'nacional' | 'municipal' }) {
  return (
    <details className="dobra" open={!certificado}>
      <summary className="dobra__titulo">{certificado ? 'Certificado A1 cadastrado' : 'Adicionar certificado A1'}</summary>
      {certificado ? <p className="painel__nota">Válido até {certificado.validoAte.slice(0, 10).split('-').reverse().join('/')}.
        {certificado.correspondeAoCnpj ? '' : ' O CNPJ do cadastro difere do certificado.'}</p> : null}
      <form action={acaoSalvarCertificadoNfse} className="formulario">
        <input type="hidden" name="emissor" value={emissor} />
        <div className="ui-field"><label className="ui-field__label" htmlFor="nfse-arquivo">Arquivo A1 (.pfx ou .p12)</label>
          <input className="ui-field__input" id="nfse-arquivo" name="certificado" type="file" accept=".pfx,.p12" required />
          <p className="ui-field__hint">Até 512 KB. Use o A1 do CNPJ completo desta unidade. O certificado da matriz não atende uma filial com CNPJ diferente nesta versão. O certificado e a senha ficam protegidos e não são exibidos depois do cadastro.</p></div>
        <div className="ui-field"><label className="ui-field__label" htmlFor="nfse-senha">Senha do certificado</label>
          <input className="ui-field__input" id="nfse-senha" name="senhaCertificado" type="password" autoComplete="new-password" maxLength={1024} /></div>
        <button className="ui-button ui-button--secondary" type="submit">{certificado ? 'Substituir certificado' : 'Salvar certificado'}</button>
      </form>
      {certificado ? <details className="dobra"><summary className="dobra__titulo">Remover certificado</summary>
        <p className="painel__nota">A emissão e as consultas ficam paradas até cadastrar outro certificado. As notas já emitidas continuam guardadas.</p>
        <form action={acaoRemoverCertificadoNfse}><input type="hidden" name="emissor" value={emissor} /><button className="ui-button ui-button--ghost" type="submit">Remover desta unidade</button></form>
      </details> : null}
    </details>
  );
}
