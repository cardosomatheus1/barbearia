import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { fotosDaBarbearia, type AlvosDeFoto } from '@/lib/admin-api';
import { painelOuDesvio } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { acaoSair } from '../acoes';
import { secao } from '../secoes';
import { FalhaDaLeitura } from '../falha-da-leitura';
import { AvisoDeRecusa } from '../aviso-de-recusa';
import { UploadDeFoto } from './upload-de-foto';

export const metadata: Metadata = {
  title: 'Fotos',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

export default async function FotosPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const resposta = await fotosDaBarbearia(token);
  const query = await searchParams;
  const salvo = first(query['salvo']) === '1';
  const removido = first(query['removido']) === '1';
  const erro = first(query['erro']);

  if (!resposta.ok) {
    return (
      <main className="ui-container painel__conteudo" {...secao('fotos')}>
        <FalhaDaLeitura code={resposta.code} href="/admin/fotos" oque="as fotos" />
      </main>
    );
  }

  const fotos: AlvosDeFoto = resposta.dados;
  const preenchidas =
    (fotos.coverUrl ? 1 : 0) +
    (fotos.logoUrl ? 1 : 0) +
    fotos.professionals.filter((p) => p.photoUrl).length +
    fotos.services.filter((s) => s.photoUrl).length;

  return (
    <main className="ui-container painel__conteudo" {...secao('fotos')}>
      <header className="painel__topo">
        <a className="painel__marca" href="/admin/dia">← {estado.businessName}</a>
        <form action={acaoSair}>
          <button className="ui-button ui-button--ghost painel__sair" type="submit">Sair</button>
        </form>
      </header>

      <h1 className="painel__titulo">Fotos e marca</h1>
      <p className="painel__sub">
        Envie os arquivos daqui. O Barberdock recorta, reduz e hospeda as imagens no próprio domínio —
        a sua página deixa de depender de links de Instagram, Drive ou outro host.
      </p>

      <AvisoDeRecusa
        erro={erro}
        mapa={{
          arquivo_vazio: 'Escolha uma imagem antes de enviar.',
          photo_too_large: 'A imagem preparada passa de 3 MB. Escolha outra.',
          invalid_photo_type: 'Envie uma imagem JPEG, PNG ou WebP.',
          invalid_photo_target: 'Não foi possível identificar onde essa imagem deve aparecer.',
          request_failed: 'Não foi possível enviar a imagem agora. Tente novamente.',
        }}
      />
      {salvo ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Imagem enviada e publicada.{' '}
          <a href={`/${estado.slug}`} rel="noopener noreferrer" target="_blank">Ver a página</a>
        </div>
      ) : null}
      {removido ? <div className="ui-alert painel__aviso" role="status">Imagem removida.</div> : null}

      <section className="painel__grupo" aria-labelledby="fotos-casa">
        <h2 className="rotulo" id="fotos-casa">A barbearia</h2>
        <UploadDeFoto
          atual={fotos.coverUrl}
          dica="Ambiente/fachada. Recorte automático 16:9, até 1600 × 900."
          rotulo="Foto do ambiente"
          target="cover"
        />
        <UploadDeFoto
          atual={fotos.logoUrl}
          dica="A imagem inteira é preservada dentro de 800 × 800."
          rotulo="Logo"
          target="logo"
        />
      </section>

      {fotos.professionals.length > 0 ? (
        <section className="painel__grupo" aria-labelledby="fotos-equipe">
          <h2 className="rotulo" id="fotos-equipe">Quem atende</h2>
          <p className="ui-field__hint">Retrato quadrado. O rosto fica no centro do recorte.</p>
          {fotos.professionals.map((pessoa) => (
            <UploadDeFoto
              atual={pessoa.photoUrl}
              dica="Recorte automático 1:1, até 800 × 800."
              key={pessoa.id}
              rotulo={pessoa.name}
              target="professional"
              targetId={pessoa.id}
            />
          ))}
        </section>
      ) : null}

      {fotos.services.length > 0 ? (
        <section className="painel__grupo" aria-labelledby="fotos-servicos">
          <h2 className="rotulo" id="fotos-servicos">Serviços</h2>
          <p className="ui-field__hint">Use a foto do resultado. Ela aparece no catálogo público.</p>
          {fotos.services.map((servico) => (
            <UploadDeFoto
              atual={servico.photoUrl}
              dica="Recorte automático 1:1, até 600 × 600."
              key={servico.id}
              rotulo={servico.name}
              target="service"
              targetId={servico.id}
            />
          ))}
        </section>
      ) : null}

      <p className="painel__nota">
        {preenchidas} imagem(ns) cadastrada(s). JPEG, PNG ou WebP; o arquivo original pode ter até 12 MB
        e a versão enviada ao servidor fica limitada a 3 MB.
      </p>
    </main>
  );
}
