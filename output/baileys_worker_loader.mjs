// Só troca a fronteira de rede. Factory, auth, runtime, fila e main são reais.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@whiskeysockets/baileys' && context.parentURL?.endsWith('/baileys/socket.js')) {
    return { url: new URL('./baileys_worker_socket_sintetico.mjs', import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
