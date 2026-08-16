/**
 * Os nomes que a aplicação já usa como rota de primeiro nível.
 *
 * ## Por que a lista mora aqui, e não onde é usada
 *
 * Dois caminhos criam slug, e os dois precisam desta lista: o legado
 * (`@barbearia/crm`, onde a barbearia digita o endereço do sistema antigo) e o
 * primário (`@barbearia/identity`, que o deriva do nome no cadastro). `crm`
 * depende de `identity` e a seta não volta — então nenhum dos dois pode guardar
 * a lista para o outro. `core` não depende de nada e serve aos dois sem inverter
 * direção nenhuma.
 *
 * ## O que acontece sem ela
 *
 * O Next dá prioridade a segmento estático sobre dinâmico. Uma barbearia com o
 * slug `plataforma` continua existindo no banco e continua aparecendo na busca;
 * o que some é a página dela. `/{slug}` nunca chega a ser consultado, porque
 * `apps/web/src/app/plataforma/` casa primeiro e o endereço passa a servir o
 * painel do Super Admin. Não há exceção, não há log, não há nada vermelho — o
 * sintoma que chega ao suporte é "meu link não abre", sobre um link que está
 * impresso no cartão e colado no espelho.
 *
 * Para o `ir` é pior, porque a colisão não é a página inicial: `/ir` é
 * redirecionador (`app/ir/[slug]/route.ts`), então a barbearia manteria a home e
 * perderia `/ir/agendar` e `/ir/entrar`. O defeito chegaria como "algumas
 * páginas minhas somem", que é bem mais difícil de ligar à causa.
 *
 * ## Quem mantém a lista
 *
 * Ninguém, à mão. `scripts/rotas-reservadas.test.mjs` deriva os nomes das pastas
 * de `apps/web/src/app` e reprova quando uma rota nova não está aqui. Manter as
 * duas à mão é o que já divergiu uma vez: a lista nasceu com sete nomes e o
 * `apps/web` cresceu quatro rotas por baixo dela.
 *
 * As entradas sem pasta correspondente estão declaradas naquele teste, cada uma
 * com o motivo escrito — é lá que se justifica uma reserva, não aqui.
 */
export const SLUGS_RESERVADOS: ReadonlySet<string> = new Set([
  // Rota de primeiro nível de `apps/web/src/app`, derivada e conferida no teste.
  'admin',
  'buscar',
  'ir',
  'pagamento',
  'plataforma',
  'privacidade',
  // Sem pasta no app. O motivo de cada uma está em `scripts/rotas-reservadas.test.mjs`.
  '_next',
  'api',
  'app',
  'assets',
  'static',
  'www',
]);
