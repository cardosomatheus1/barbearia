# Origem

Skill oficial da Anthropic, copiada de:
`anthropics/claude-code` → `plugins/frontend-design/skills/frontend-design/`

Instalada no repositório (e não só na máquina) para que qualquer pessoa que
trabalhe neste projeto receba a mesma orientação de design.

Licença em `LICENSE.md`, de `anthropics/claude-code`. O `SKILL.md` referencia um
`LICENSE.txt` que não existe naquele caminho; a licença do repositório é a que
vale.

## Relação com o CLAUDE.md

As duas coisas se complementam e nenhuma substitui a outra:

- **`CLAUDE.md` §5 define o piso** — responsivo a partir de 360px, contraste
  medido, alvo de toque de 44px, foco visível, sem rolagem horizontal. São
  obrigações, várias com teste.
- **Esta skill define o teto** — direção estética, tipografia com personalidade,
  um elemento assinatura, fugir do que parece template.

Em caso de conflito, o piso vence: um layout marcante que quebra em 360px ou
reprova no contraste não entra.

## Alerta de calibração que se aplica a este projeto

A skill lista três aparências em que design gerado por IA costuma cair. A
segunda é "fundo quase preto com um único acento vivo" — que é exatamente a
descrição superficial do tema escuro do bloco 6 (`#0E0E10` + âmbar).

A escolha do âmbar tem lastro (couro, latão, a identidade do setor) e passou por
verificação de contraste, mas isso **não basta como diferenciação visual**. O
bloco 7 precisa buscar personalidade em tipografia, estrutura e no elemento
assinatura — não na paleta, que já está no lugar mais previsível possível.
