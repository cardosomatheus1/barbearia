import { redirect } from 'next/navigation';

/**
 * "Avisos ao cliente" virou a metade *Do horário marcado* de Mensagens
 * automáticas (bloco 145).
 *
 * A rota fica, e redireciona. O destino saiu do menu, mas não do mundo: ele está
 * no favorito de quem já usava, no link que alguém mandou por WhatsApp e no
 * histórico do navegador do balcão. Tirar a rota junto com a entrada do menu
 * transformaria a fusão num 404 para quem tinha o caminho na mão.
 */
export default function AvisosPage() {
  redirect('/admin/automacoes#do-horario');
}
