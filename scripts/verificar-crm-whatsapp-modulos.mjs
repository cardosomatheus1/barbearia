import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const raiz = join(import.meta.dirname, '..');
const ler = (p) => readFileSync(join(raiz, p), 'utf8');
const linhas = (s) => s.split('\n').length;
const exigir = (ok, msg) => { if (!ok) throw new Error(msg); };

const fachada = ler('packages/crm/src/whatsapp.ts');
const erros = ler('packages/crm/src/whatsapp-erros.ts');
const cadastro = ler('packages/crm/src/whatsapp-cadastro.ts');
const templates = ler('packages/crm/src/whatsapp-templates.ts');
const mensagens = ler('packages/crm/src/whatsapp-mensagens.ts');
const assinatura = ler('packages/crm/src/whatsapp-assinatura.ts');
const roteamento = ler('packages/crm/src/whatsapp-roteamento.ts');
const lifecycle = ler('packages/crm/src/whatsapp-lifecycle.ts');
const submissao = ler('packages/crm/src/whatsapp-template-submissao.ts');
const entrega = ler('packages/crm/src/whatsapp-template-entrega.ts');
const numero = ler('packages/crm/src/whatsapp-numero.ts');
const promocional = ler('packages/crm/src/disparo-promocional.ts');

// O hotspot original tinha 1.490 linhas e misturava credencial, templates,
// envio/inbound, assinatura criptográfica e resolução pública de tenant.
exigir(linhas(fachada) <= 80, `whatsapp.ts deixou de ser fachada: ${linhas(fachada)} linhas`);
exigir(linhas(erros) <= 70, `whatsapp-erros.ts cresceu além do contrato: ${linhas(erros)} linhas`);
exigir(linhas(cadastro) <= 450, `whatsapp-cadastro.ts cresceu demais: ${linhas(cadastro)} linhas`);
exigir(linhas(templates) <= 400, `whatsapp-templates.ts cresceu demais: ${linhas(templates)} linhas`);
exigir(linhas(mensagens) <= 650, `whatsapp-mensagens.ts cresceu demais: ${linhas(mensagens)} linhas`);
exigir(linhas(assinatura) <= 100, `whatsapp-assinatura.ts cresceu demais: ${linhas(assinatura)} linhas`);
exigir(linhas(roteamento) <= 50, `whatsapp-roteamento.ts cresceu demais: ${linhas(roteamento)} linhas`);
exigir(linhas(lifecycle) <= 100, `whatsapp-lifecycle.ts cresceu demais: ${linhas(lifecycle)} linhas`);
exigir(linhas(submissao) <= 160, `whatsapp-template-submissao.ts cresceu demais: ${linhas(submissao)} linhas`);
// A ida à Meta saiu de `whatsapp-templates.ts` no bloco 133, e foi esta guarda
// que cobrou: o arquivo passou de 400 para 520 linhas ao ganhar o caminho do
// worker. O corte é o mesmo da submissão — pedir, entregar e ler são três
// coisas, e a terceira é a única que o balcão espera.
exigir(linhas(entrega) <= 220, `whatsapp-template-entrega.ts cresceu demais: ${linhas(entrega)} linhas`);
// A conciliação do número saiu de `whatsapp-cadastro.ts` no bloco 134, e foi
// esta guarda que cobrou de novo: o arquivo passou de 450 ao ganhar a tarefa de
// inscrição da WABA. O corte é o mesmo da submissão de template — gravar o
// cadastro e perguntar à Meta se ele foi provado são duas coisas.
exigir(linhas(numero) <= 120, `whatsapp-numero.ts cresceu demais: ${linhas(numero)} linhas`);
exigir(linhas(promocional) <= 220, `disparo-promocional.ts cresceu demais: ${linhas(promocional)} linhas`);

for (const [nome, fonte] of [
  ['whatsapp-erros.ts', erros],
  ['whatsapp-cadastro.ts', cadastro],
  ['whatsapp-templates.ts', templates],
  ['whatsapp-mensagens.ts', mensagens],
  ['whatsapp-assinatura.ts', assinatura],
  ['whatsapp-roteamento.ts', roteamento],
  ['whatsapp-lifecycle.ts', lifecycle],
  ['whatsapp-template-submissao.ts', submissao],
  ['whatsapp-template-entrega.ts', entrega],
  ['whatsapp-numero.ts', numero],
  ['disparo-promocional.ts', promocional],
]) {
  exigir(!fonte.includes("from './whatsapp.js'"), `${nome} criou dependência circular com a fachada`);
}

// A entrega é do worker, e a reserva é quem a agenda: sem a tarefa dentro da
// transação existe a janela em que a linha está em `sending` e nada está
// marcado para levá-la à Meta — e `sending` recusa a submissão seguinte.
exigir(submissao.includes("kind: 'whatsapp.submeter_template'"), 'a reserva deixou de enfileirar a ida à Meta');
exigir(submissao.includes('await enfileirar(tx, {'), 'a tarefa saiu de dentro da transação da reserva');
exigir(!templates.includes('provider.submeterTemplate'), 'a ida à Meta voltou para o caminho da requisição');
exigir(entrega.includes('meta_id IS NULL'), 'a soltura passou a alcançar texto que a Meta já conhece');

// Credencial: segredo dedicado, nunca devolvido em leitura e falha alta quando
// a linha/token não está utilizável.
exigir(cadastro.includes("const CHAVE_DO_TOKEN = 'WHATSAPP_TOKEN_KEY'"), 'token perdeu chave dedicada');
exigir(cadastro.includes('(access_token_cipher IS NOT NULL) AS tem_token'), 'cadastro deixou de devolver só presença do token');
exigir(cadastro.includes("recusar('token_invalido')"), 'token corrompido deixou de falhar alto');
// A inscrição do app na WABA nasce com o cadastro, e dentro da transação: sem
// ela a Meta aceita as mensagens e nunca conta o desfecho de nenhuma.
exigir(cadastro.includes("kind: 'whatsapp.assinar_waba'"), 'o cadastro deixou de enfileirar a inscrição na WABA');
exigir(!/return\s+\{[^}]*access_token_cipher/s.test(cadastro), 'credencial cifrada entrou no retorno do cadastro');

// Templates: limites da Meta e destinos controlados pelo cadastro da própria casa.
for (const teto of ['TETO_DE_RESPOSTA_RAPIDA', 'TETO_DE_LINK', 'TETO_DE_LIGACAO']) {
  exigir(templates.includes(teto), `template perdeu limite ${teto}`);
}
exigir(templates.includes("process.env['WEB_URL']"), 'botão de agenda deixou de usar URL pública controlada');
exigir(templates.includes("SELECT (SELECT slug FROM tenant_slugs"), 'destino do botão deixou de resolver slug do tenant');

// Mensagens/inbound: fallback, idempotência e prova de posse do agendamento.
exigir(mensagens.includes('if (!cadastro || !whatsappDisponivel(cadastro.estado)) return null;'), 'envio deixou de cair para canal de reserva quando indisponível');
exigir(mensagens.includes('ON CONFLICT (wamid) DO NOTHING'), 'idempotência por wamid deixou de existir');
exigir(mensagens.includes('AND c.phone_e164 = ${params.telefone}'), 'inbound perdeu prova de cliente pelo telefone');
exigir(mensagens.includes("kind: 'whatsapp.responder'"), 'inbound deixou de enfileirar tratamento desacoplado');
exigir(mensagens.includes("if (resposta.botao === 'parar_de_receber')"), 'opt-out deixou de ser tratado sem exigir agendamento');

// Webhook: formato estrito e comparação constante; rota pública só resolve ids.
exigir(assinatura.includes("const prefixo = 'sha256='"), 'assinatura perdeu prefixo sha256');
exigir(assinatura.includes("/^[0-9a-f]+$/i"), 'assinatura deixou de validar hexadecimal');
exigir(assinatura.includes('timingSafeEqual'), 'assinatura deixou de usar comparação timing-safe');
exigir(roteamento.includes('semTenant'), 'porta do webhook deixou de resolver tenant antes da RLS');
exigir(roteamento.includes('SELECT tenant_id, location_id FROM whatsapp_numbers'), 'roteamento público passou a ler mais que ids de roteamento');

console.log(
  `crm/whatsapp modular: fachada ${linhas(fachada)}; cadastro ${linhas(cadastro)}; numero ${linhas(numero)}; templates ${linhas(templates)}; entrega ${linhas(entrega)}; mensagens ${linhas(mensagens)}; assinatura ${linhas(assinatura)}; roteamento ${linhas(roteamento)}; lifecycle ${linhas(lifecycle)}; submissao ${linhas(submissao)}; promocional ${linhas(promocional)} linhas`,
);
