#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const arquivos = {
  pagina: 'apps/web/src/app/admin/fotos/page.tsx',
  ilha: 'apps/web/src/app/admin/fotos/upload-de-foto.tsx',
  api: 'apps/api/src/admin/admin.controller.ts',
  storage: 'apps/api/src/media/storage.ts',
  main: 'apps/api/src/main.ts',
  proxy: 'apps/web/src/app/media/[tenantId]/[arquivo]/route.ts',
  compose: 'deploy/compose.yml',
  composeLocal: 'docker-compose.yml',
  env: '.env.example',
  configurarS3: 'deploy/configurar-midia-s3.sh',
  caddy: 'deploy/Caddyfile',
  backup: 'deploy/backup.sh',
  cliente: 'apps/web/src/app/admin/cliente/[id]/componentes.tsx',
  next: 'apps/web/next.config.mjs',
  onboarding: 'packages/onboarding/src/onboarding.ts',
};
const texto = Object.fromEntries(Object.entries(arquivos).map(([k, p]) => [k, readFileSync(p, 'utf8')]));
const problemas = [];
const exige = (cond, msg) => { if (!cond) problemas.push(msg); };

exige(!/type=["']url["']/.test(texto.pagina), 'a tela /admin/fotos voltou a pedir URL');
exige(!/Cole o endereço de fotos/i.test(texto.pagina), 'a tela voltou ao texto de colar endereço');
exige(texto.ilha.startsWith("'use client';"), 'o preparo local da imagem deixou de ser ilha client-side');
exige(/canvas\.toBlob/.test(texto.ilha) && /image\/webp/.test(texto.ilha), 'a ilha deixou de comprimir em WebP');
exige(/1600, height: 900/.test(texto.ilha) && /800, height: 800/.test(texto.ilha), 'as proporções/tetos de recorte sumiram');
exige(/DataTransfer/.test(texto.ilha), 'o arquivo preparado não substitui o original antes do envio');

exige(/@Post\('photos\/upload'\)/.test(texto.api), 'a API perdeu o endpoint de upload');
exige(/bodySizeLimit:\s*'4mb'/.test(texto.next), 'Server Action voltou ao teto padrão de 1 MB e pode cortar uploads válidos');
exige(/getPhotoTargets\(tenantId: string, locationId: string\)/.test(texto.onboarding), 'alvos de foto perderam o recorte por unidade');
exige(/SELECT cover_url FROM locations WHERE id = \$\{locationId\}::uuid/.test(texto.onboarding), 'capa voltou a ser lida de uma unidade arbitrária');
exige((texto.api.match(/getPhotoTargets\(staff\.tenantId, local\.id\)/g) ?? []).length >= 3, 'API de fotos não usa a unidade ativa ao ler/substituir mídia');
exige(/WHERE active AND kind = 'professional' AND location_id = \$\{locationId\}::uuid/.test(texto.onboarding), 'equipe de fotos voltou a atravessar unidades');
exige(/WHERE id = \$\{pessoa.id\}::uuid AND location_id = \$\{locationId\}::uuid/.test(texto.onboarding), 'atualização de foto do profissional voltou a atravessar unidades');
exige(/TETO_IMAGEM_PUBLICA/.test(texto.api), 'a API não limita o corpo do upload');
exige(/fotoDaCasa/.test(texto.api) && /startsWith\(`\/media\/\$\{staff\.tenantId\}\//.test(texto.api), 'endpoint legado voltou a aceitar host/tenant arbitrário');
exige(/tipoDaImagem/.test(texto.storage) && /randomUUID/.test(texto.storage), 'storage não confere assinatura ou não usa nome opaco');
exige(/\.startsWith\(`\$\{base\}\$\{sep\}`\)/.test(texto.storage), 'proteção contra traversal do fallback local sumiu');
exige(/cache-control/.test(texto.proxy) && /immutable/.test(texto.proxy), 'proxy público perdeu cache imutável');

// R9 literal: existe object storage real S3-compatível. O bucket permanece
// privado; a aplicação assina a chamada de servidor e não devolve endpoint nem
// credencial ao navegador.
exige(/export type ModoDeMidia = 'local' \| 's3'/.test(texto.storage), 'storage perdeu seleção local/s3');
exige(/AWS4-HMAC-SHA256/.test(texto.storage) && /aws4_request/.test(texto.storage), 'backend S3 não assina com AWS Signature V4');
exige(/fetchS3\('PUT'/.test(texto.storage) && /fetchS3\('GET'/.test(texto.storage) && /fetchS3\('DELETE'/.test(texto.storage), 'backend S3 não implementa PUT/GET/DELETE');
for (const nome of ['MEDIA_S3_ENDPOINT', 'MEDIA_S3_BUCKET', 'MEDIA_S3_ACCESS_KEY_ID', 'MEDIA_S3_SECRET_ACCESS_KEY']) {
  exige(texto.storage.includes(`obrigatoria('${nome}')`), `storage S3 não exige ${nome}`);
  exige(texto.compose.includes(`${nome}: \${${nome}:-}`), `compose de produção não repassa ${nome}`);
  exige(texto.composeLocal.includes(`${nome}: \${${nome}:-}`), `compose local não repassa ${nome}`);
  exige(texto.env.includes(nome), `.env.example não documenta ${nome}`);
}
exige(/validarConfiguracaoDeMidia\(\)/.test(texto.main), 'API não valida a configuração de mídia no bootstrap');
exige(/setar MEDIA_STORAGE s3/.test(texto.configurarS3), 'deploy não oferece caminho explícito para habilitar S3');
exige(/setar MEDIA_S3_SECRET_ACCESS_KEY/.test(texto.configurarS3), 'script S3 não persiste a credencial secreta');

// Exclusão física depois do commit é limpeza, não parte da verdade lógica.
exige(/export async function tentarApagarImagemPublica/.test(texto.storage), 'storage não oferece limpeza best-effort pós-commit');
exige((texto.api.match(/tentarApagarImagemPublica\(anterior, staff\.tenantId\)/g) ?? []).length >= 2, 'troca/remoção de foto volta a falhar por limpeza pós-commit');
exige(/tentarApagarImagemPublica\(guardada\.url, staff\.tenantId\)/.test(texto.api), 'falha ao salvar no banco pode mascarar o erro original durante limpeza do arquivo novo');

// O fallback local continua persistente e entra no backup. No modo S3 o
// backup não cria um tar vazio fingindo copiar o bucket; ele declara que
// versionamento/retention é responsabilidade do object storage.
exige(/media:\/data\/media/.test(texto.compose) && /^\s*media:\s*$/m.test(texto.compose), 'fallback local deixou de persistir mídia em volume');
exige(/MEDIA_STORAGE/.test(texto.backup) && /if \[ "\$MEDIA_STORAGE" = "local" \]/.test(texto.backup), 'backup não distingue volume local de object storage');
exige(/versionamento\/retention no bucket/.test(texto.backup), 'backup não explicita retenção externa no modo object storage');
exige(/handle \/media\/\*/.test(texto.caddy), 'Caddy não serve /media pelo domínio público');

// R9 não pode enfraquecer a regra especial de imagem de cliente.
exige(/podeGuardar = consentimentos\.atuais\.photos\?\.concedido === true/.test(texto.cliente), 'foto de cliente perdeu a guarda de consentimento para armazenar');
exige(/podePublicar = consentimentos\.atuais\.photos_public\?\.concedido === true/.test(texto.cliente), 'foto de cliente perdeu a guarda de consentimento para publicar');

if (problemas.length) {
  console.error(`R9 mídia: ${problemas.length} problema(s)`);
  for (const p of problemas) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('R9 mídia: upload, recorte, S3 compatível, domínio próprio, fallback/backup e consentimento coerentes');
