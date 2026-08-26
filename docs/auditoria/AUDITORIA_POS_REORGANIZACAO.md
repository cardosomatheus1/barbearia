# Auditoria pós-reorganização

Esta versão incorpora as correções encontradas na revisão profunda após R12.

## Correções adicionais aplicadas

### Auditoria corretiva independente de 23/08/2026

Depois da comparação independente entre ZIP original, backlog e versão auditada, foram encontradas e tratadas novas divergências:

- **V2 Ficha — gasto total:** o cabeçalho somava apenas as 10 ocorrências da timeline e rotulava o resultado como “no total”. Corrigido com uma leitura financeira própria (`customers.view` + `finance.view`) que soma **todos os pedidos pagos**.
- **V2 Ficha — última visita:** a tela usava a primeira ocorrência da timeline, que também contém falta/cancelamento. Corrigido para usar somente o último atendimento `completed`.
- **V9 Semântica de cor:** `danger` era usado como decoração/navegação no shell, landing, brilho de cards numéricos e filtro ativo do Painel; além disso, `paid` usava cor de ação. Os usos foram normalizados (`danger` para problema, `warning` para preço acima da base, `success` para pago) e a guarda V7/V8/V9 foi ampliada.
- **R9 Mídia:** uma falha de `unlink` depois do commit podia devolver 500 mesmo com a troca/remoção já salva no banco. A limpeza física passou a ser best-effort depois do commit; falha pode deixar órfão para reconciliação, gera warning e não falsifica o resultado lógico.
- **V10 Agenda:** documentação reconciliada com o comportamento proporcional: intervalo menor que 44px **não vira alvo pequeno nem é esticado**; permanece informativo. Todo alvo realmente interativo mantém 44px.
- **V8 Hierarquia:** o critério original foi preservado. A guarda agora é descrita apenas como prova estrutural: moldes V7 cobrem todas as seções e os três níveis são explícitos nas superfícies de maior frequência. **V8 global continua pendente de revisão visual das demais telas**; `data-*` mecânico não substitui essa prova.

As guardas V2, R9 e V7/V8/V9 foram reforçadas para cobrir os três bugs/escapes acima.

- R9 Fotos: leitura/substituição corrigida para respeitar a unidade atual em multiunidade.
- R9 Upload: `serverActions.bodySizeLimit` elevado para 4 MB, compatível com o teto de 3 MB do arquivo preparado + overhead multipart.
- V6 Painel: títulos e textos de período agora acompanham `Hoje`, `7 dias` e `30 dias`, em vez de dizer “hoje” para períodos maiores.
- V2 Ficha: ações de Fidelidade/Financeiro retornam à aba correspondente.
- V2 Ficha: consultas foram recortadas por aba para evitar carga desnecessária.
- R11: contrato público da fachada revisado; dependências/imports locais auditados.

## Auditorias executadas sem dependências externas

- Parse TypeScript/TSX pós-correção: 736 arquivos, sem erro sintático.
- Scanner independente pós-correção: 2.253 imports internos/locais coletados pelo seu critério, sem caminho ausente. A auditoria anterior usou outro scanner e contou 2.629; as contagens não são tratadas como equivalentes.
- Guardas dos blocos R7, V0, V1, V3, V4, V5, R5, R6, V10, V11, V2, V6, V7/V8/V9, R8, R9, R10, R11 e R12: verdes na revisão.

## Limitação ainda existente

O `verify` integral com Vitest/PostgreSQL/Next build continua dependente de um ambiente com as dependências do projeto instaladas. Neste ambiente, o Corepack tentou obter `pnpm@10.33.0`, mas o registry não estava acessível; portanto **R5/bundle continua não medido**. R12 também continua dependente de pessoas reais e 3–5 barbearias. Esta auditoria reforça cobertura estática/contratual, mas não substitui banco, build, navegador e uso humano reais.
