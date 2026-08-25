#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const ler = (arquivo) => readFileSync(new URL(`../${arquivo}`, import.meta.url), 'utf8');
const busca = ler('apps/web/src/app/admin/busca-global.tsx');
const rota = ler('apps/web/src/app/admin/busca/route.ts');
const casco = ler('apps/web/src/app/admin/casco.tsx');
const secoes = ler('apps/web/src/app/admin/secoes.ts');
const ficha = ler('apps/web/src/app/admin/cliente/[id]/page.tsx');
const dia = ler('apps/web/src/app/admin/dia/page.tsx');
const css = ler('apps/web/src/app/admin/busca-global.module.css');

const erros = [];
const exigir = (condicao, texto) => { if (!condicao) erros.push(texto); };

exigir(busca.startsWith("'use client';"), 'a paleta global precisa ser uma ilha client-side explícita');
exigir(busca.includes("evento.ctrlKey || evento.metaKey") && busca.includes("key.toLowerCase() === 'k'"), 'Ctrl/⌘+K precisa abrir a busca');
exigir(busca.includes('/admin/busca?q='), 'a ilha precisa consultar a ponte autenticada do admin');
exigir(busca.includes('filtrarDestinos(destinos, consulta'), 'funções precisam ser buscadas sobre os destinos permitidos recebidos do servidor');
exigir(casco.includes('const modulos = modulosVisiveis(recursos, permissoes)'), 'a busca precisa nascer depois do recorte de recursos/permissões');
exigir(casco.includes('<BuscaGlobal destinos={destinosDaBusca} />'), 'o casco precisa montar a busca global');
exigir(!casco.includes('MODULOS.flatMap((modulo) =>\n    modulo.telas.map'), 'não passe o registro bruto para a ilha antes do recorte de permissão');

exigir(rota.includes("permissoes.has('customers.view')"), 'busca de cliente precisa respeitar customers.view');
exigir(rota.includes("permissoes.has('appointments.view') && podeVerClientes"), 'busca de agenda com nome de cliente precisa declarar as duas permissões');
exigir(rota.includes('buscarClientes(token, q)'), 'cliente deve reutilizar a busca já existente');
exigir(rota.includes('agendaDoAdmin(token)'), 'agendamento deve reutilizar a agenda já recortada por unidade/profissional');
exigir(rota.includes("'cache-control': 'no-store, private'"), 'resultado com dado pessoal não pode entrar em cache');

exigir(ficha.includes('aria-label="Ações deste cliente"'), 'a ficha precisa ter ações contextuais explícitas');
exigir(ficha.includes('/admin/dia/marcar?c=${encodeURIComponent(id)}&cn=${encodeURIComponent(ficha.dados.nome)}'), 'Agendar deve carregar o cliente sem procurá-lo de novo');
exigir(ficha.includes('?aba=visao&de=${origem}#mandar-mensagem'), 'WhatsApp deve agir no contexto da ficha, preservar a origem e abrir a aba correta');
exigir(dia.includes('id={`atendimento-${linha.id}`}'), 'resultado de agendamento precisa cair no atendimento exato');
exigir(css.includes('@media (max-width: 560px)') && css.includes('min-height: 44px'), 'gatilho mobile precisa manter alvo de toque de 44px');

// O registro continua sendo a única lista de funções; V11 não pode criar uma
// cópia de nomes/hrefs dentro do componente de cliente.
const hrefsDoRegistro = [...secoes.matchAll(/href: '(\/admin\/[^']+)'/g)].map((m) => m[1]);
for (const href of hrefsDoRegistro) {
  if (href === '/admin/assistente') continue; // pode aparecer por texto no comentário/atalho do casco
  exigir(!busca.includes(`'${href}'`) && !busca.includes(`\"${href}\"`), `href ${href} foi copiado para a ilha; derive do registro`);
}

if (erros.length) {
  console.error(`V11 reprovado (${erros.length}):`);
  for (const erro of erros) console.error(`- ${erro}`);
  process.exit(1);
}

console.log(`V11 ok: busca global permissionada, ${hrefsDoRegistro.length} destinos continuam derivados, ações contextuais ligadas.`);
