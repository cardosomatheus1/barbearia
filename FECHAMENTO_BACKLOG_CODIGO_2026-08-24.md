# Barberdock — fechamento do backlog que depende de código

**Data:** 24/08/2026  
**Base:** `barberdock-auditoria-profunda-corrigido-final-2026-08-24`  
**Backlog de referência:** `docs/auditoria/04-backlog-pos-revisao-corrigido.md`

## Veredito

Tudo que ainda dependia de **implementação no repositório** foi fechado nesta árvore.
Isso não transforma os critérios externos em teste automatizado: V8 ainda exige revisão visual humana, R5 ainda exige build/medição real e R12 ainda exige pessoas novas usando o produto em campo.

Em outras palavras:

- **backlog dependente de código:** fechado;
- **aceitação total do backlog:** ainda depende das provas externas explicitamente previstas no próprio backlog.

## V0–V11

| Item | Código | Aceite que ainda não é código |
|---|---|---|
| V0 | concluído | — |
| V1 | concluído | — |
| V2 | concluído | — |
| V3 | concluído | — |
| V4 | concluído | — |
| V5 | concluído | — |
| V6 | concluído | — |
| V7 | concluído | — |
| V8 | contrato estrutural concluído | revisão visual global das telas |
| V9 | concluído | — |
| V10 | concluído | — |
| V11 | concluído | — |

O guarda V7/V8/V9 continua deliberadamente sem fingir que atributos DOM substituem uma revisão visual. Ele prova moldes e os três níveis nas superfícies-chave, enquanto a inspeção visual global continua humana.

## R5–R12

| Item | Código | Aceite que ainda não é código |
|---|---|---|
| R5 | ilha de cliente e medidor de bundle concluídos | `next build` real + bundle/LCP |
| R6 | concluído | — |
| R7 | concluído | — |
| R8 | concluído | — |
| R9 | concluído também no sentido literal de object storage | smoke contra bucket/provedor real configurado |
| R10 | concluído | — |
| R11 | concluído | — |
| R12 | protocolo, cronômetro e percursos concluídos | pessoas reais + 3–5 barbearias |

## R9 — fechamento da última ambiguidade de código

A implementação anterior já fazia upload, recorte, compressão, nome opaco, `/media/...`, consentimento e persistência local. Faltava apenas eliminar a ambiguidade entre “armazenamento próprio” e **object storage literal**.

Agora `apps/api/src/media/storage.ts` oferece dois backends:

- `MEDIA_STORAGE=local`: fallback de desenvolvimento/instalação simples;
- `MEDIA_STORAGE=s3`: AWS S3, Cloudflare R2 ou MinIO por API S3 compatível.

O backend S3:

- implementa PUT, GET e DELETE;
- assina as requisições com AWS Signature V4;
- mantém o bucket privado;
- nunca entrega endpoint, bucket ou credenciais ao navegador;
- preserva a URL pública `/media/<tenant>/<uuid>.<ext>`;
- valida assinatura real do arquivo na leitura e escrita;
- mantém limpeza pós-commit best-effort;
- exige configuração completa quando o modo S3 é escolhido.

Foram atualizados `.env.example`, `docker-compose.yml`, `deploy/compose.yml`, documentação e backup. `deploy/configurar-midia-s3.sh` configura o backend sem alterar a URL pública. No modo S3 o backup não cria um `tar` vazio do volume local; versionamento/retention do bucket fica explicitamente sob o provedor.

## Validação desta árvore

- guardas `verificar-*.mjs`: **23 OK / 0 falhas**;
- TS/TSX: **742 / 0 erros de parse**;
- JS/MJS/CJS: **71 / 0 erros de sintaxe**;
- shell: **30 / 0 erros de sintaxe**;
- JSON: **46 válidos**;
- YAML: **6 válidos**;
- scripts `.test.mjs` independentes de Vitest: **5 OK / 0 falhas**;
- imports internos verificados: **2.677 / 0 caminhos ausentes** (3 imports deliberados para `dist` dependem do build);
- R9 SigV4: **PUT/GET/DELETE executados com fetch interceptado e assinatura recalculada independentemente — OK**;
- `deploy/segredos.sh`: primeira execução e reexecução preservando valores — OK;
- `deploy/configurar-midia-s3.sh`: configuração de ambiente — OK.

O `scripts/verify.sh` foi tentado novamente. O ambiente continua sem `pg_isready`/PostgreSQL e sem `pnpm`; por isso o portão full-stack não pode ser concluído aqui. As fases estáticas foram executadas separadamente acima.

## O que sobra para encerrar o backlog como aceitação, não como código

1. **V8:** revisão visual global das demais telas, nos dois temas e larguras relevantes.
2. **R5:** `pnpm install`, `next build`, execução do medidor de bundle e comparação de LCP/bundle público.
3. **R12:** rodada pós-reorganização com pessoas que nunca usaram o produto e operação assistida em 3–5 barbearias.
4. **R9 em produção S3:** provisionar bucket/credenciais e fazer smoke real de upload → `/media` → página pública. O código necessário já está presente.

Nenhum desses quatro pontos restantes é resolvido adicionando outra função ao repositório; são provas em ambiente ou com pessoas.
