# Barberdock — Correção da esteira de certificação prática

**Data:** 25/08/2026  
**Base:** `barberdock-auditoria-final-recheck-2026-08-25.zip`  
**Objetivo:** corrigir as lacunas encontradas na checagem dos portões restantes sem transformar dependências externas em funcionalidades fictícias.

## Veredito

As lacunas corrigíveis no pacote foram tratadas:

- a medição agora sobe **API + Web + Worker**;
- a partida do Worker é observada pelo evento estruturado `worker.iniciado`;
- a medição provoca `SIGKILL`, reinicia o Worker e exige que ele permaneça vivo durante os percursos e as duas cargas;
- foi adicionada carga destrutiva com **100 reservas simultâneas no mesmo slot**;
- a carga exige exatamente um vencedor, todas as demais respostas como conflito 409 de domínio, zero 500, replay idempotente e exatamente uma reserva ativa no PostgreSQL;
- o contrato da carga ganhou teste autônomo positivo e negativo;
- a documentação foi atualizada para 116 migrações, 10 percursos existentes e cobertura de navegador ainda pendente;
- fiscal e split permanecem corretamente classificados como sem provider real;
- uma nova guarda permanente e oito mutações negativas impedem remover silenciosamente essas correções.

O pacote não declara que as provas dependentes de PostgreSQL/build/provider passaram neste runtime. Ele entrega a esteira corrigida para executá-las no ambiente apropriado.

## Correções implementadas

### 1. Worker incluído na pilha de medição

`scripts/medicao.sh` passou a:

1. construir e migrar o banco descartável;
2. subir API, Web e Worker;
3. aguardar o evento real de partida do Worker;
4. matar o processo com `SIGKILL`;
5. reiniciá-lo;
6. verificar que ele continua vivo depois dos percursos, da carga de disponibilidade e da carga de reserva;
7. incluir o log do Worker no diagnóstico e encerrá-lo no cleanup.

A suíte de `packages/jobs` já prova a outra metade do crash: tarefa órfã volta à fila, tentativa não é zerada e claim antiga não conclui a retomada.

### 2. Carga destrutiva de reserva

Novo arquivo:

`scripts/carga-concorrencia-reserva.mjs`

Contrato padrão:

- 100 disputantes simultâneos;
- mínimo configurável de 50 e máximo de 500;
- mesmo profissional, data e início;
- chaves de idempotência distintas;
- exatamente 1 resposta de sucesso;
- 99 respostas HTTP 409 com `slot_taken` ou `slot_not_available`;
- nenhuma resposta inesperada/500;
- replay da chave vencedora devolvendo o mesmo agendamento;
- consulta direta ao PostgreSQL confirmando uma única linha ativa no slot.

O comando também ficou exposto como:

`pnpm test:carga-reserva`

### 3. Teste do próprio ensaio

Novo arquivo:

`scripts/carga-concorrencia-reserva.test.mjs`

Sem depender de PostgreSQL real, ele usa servidor e `psql` controlados para provar que:

- 1 vencedor + 49 conflitos + replay + uma linha é aceito;
- uma única resposta 500 reprova o ensaio.

A execução real continua usando 100 reservas e PostgreSQL na medição.

### 4. Guarda permanente

Novos arquivos:

- `scripts/verificar-certificacao-pratica.mjs`;
- `scripts/verificar-certificacao-pratica.test.mjs`.

A guarda foi incluída em `scripts/verify.sh` e protege:

- Worker dentro da medição;
- queda e retomada por `SIGKILL`;
- carga mínima de 50 e padrão de 100;
- um único vencedor;
- conflitos 409 de domínio;
- replay idempotente;
- conferência direta no banco;
- chamada da carga pela medição;
- execução na CI;
- contagem atual de migrações;
- documentação honesta sobre E2E e providers.

As oito mutações negativas foram detectadas.

### 5. Documentação e CI

Atualizados:

- `.github/workflows/portao.yml`;
- `docs/go-live.md`;
- `docs/deploy.md`;
- `ROADMAP.md`;
- `package.json`.

Principais ajustes:

- CI descrita como pilha API + Web + Worker e duas cargas;
- 83 migrações históricas substituídas pelas 116 atuais;
- seis percursos históricos substituídos pelos 10 existentes;
- medição antiga de restauração marcada como histórica e pendente de repetição no head `0116`;
- cobertura de navegador ausente passou a constar explicitamente no go/no-go;
- provider real de fiscal e split não é mais tratado como simples preenchimento de credencial.

## Cobertura que permanece pendente

Não foram criados percursos Playwright fictícios sem possibilidade de execução. Continuam como portão explícito:

- cancelar/remarcar;
- lista de espera/oferta;
- walk-in e atendimento;
- pacote/assinatura;
- multiunidade simultânea;
- estorno refletido na UI;
- WhatsApp real.

Também permanecem externos:

- aplicação e provas das 116 migrações em PostgreSQL 16 real;
- typecheck, Vitest completo e build;
- execução real da medição corrigida;
- backup/restore no head `0116`;
- WABA central, WhatsApp CRM e Stripe reais;
- implementação de providers reais de fiscal e split;
- piloto em barbearias.

## Validação executada neste runtime

- guardas diretas aplicáveis: **48/48 PASS**;
- testes Node autônomos: **29/29 arquivos PASS**;
- asserções Node: **237/237 PASS**;
- mutações negativas da certificação prática: **8/8 detectadas**;
- contrato autônomo da carga: **2/2 PASS**;
- shell `bash -n`: **30/30 PASS**;
- YAML: **7/7 PASS**;
- sintaxe dos novos arquivos MJS: **PASS**;
- migrações presentes: **116**, `0001 → 0116`.

## Classificação final

**Problemas corrigíveis da esteira:** corrigidos.  
**Regressões nas guardas existentes:** nenhuma encontrada.  
**Portões externos:** preservados como pendentes, sem selo falso.  
**Base canônica seguinte:** este pacote substitui o ZIP do Recheck Final para a próxima execução em PostgreSQL/CI.

