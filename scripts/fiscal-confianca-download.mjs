import { request } from 'node:https';
import { request as requestHttp } from 'node:http';
import { lookup } from 'node:dns';
import { isIP, BlockList } from 'node:net';

const ipv6Especial = new BlockList();
for (const [rede, prefixo] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) {
  ipv6Especial.addSubnet(rede, prefixo, 'ipv6');
}

// O manifesto é da instalação, não do PFX nem do cliente. Mesmo assim, não
// permitir que uma configuração errada alcance metadados ou serviços locais.
export function enderecoPublico(ip) {
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
  }
  // Somente IPv6 global unicast; IPv4 mapeado, loopback e link-local recusados.
  return isIP(ip) === 6 && /^[23][0-9a-f]{3}:/i.test(ip) && !ipv6Especial.check(ip, 'ipv6');
}

export function urlDaFonte(valor, crl = false) {
  if (typeof valor !== 'string' || valor.length > 2048) throw new Error('fonte_invalida');
  const url = new URL(valor);
  if (!(url.protocol === 'https:' || (crl && url.protocol === 'http:')) || url.username || url.password ||
      url.hash || (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) ||
      !url.hostname.includes('.') || (isIP(url.hostname.replace(/^\[|\]$/g, '')) && !enderecoPublico(url.hostname.replace(/^\[|\]$/g, '')))) {
    throw new Error('fonte_invalida');
  }
  return url;
}

export function baixarPublico(valor, limite, crl = false) {
  const url = urlDaFonte(valor, crl);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => req.destroy(new Error('download_timeout')), 20_000);
    const req = (url.protocol === 'https:' ? request : requestHttp)(url, {
      method: 'GET', headers: { accept: 'application/pkix-cert, application/pkix-crl, application/octet-stream' },
      lookup: (host, options, callback) => lookup(host, { ...options, all: true }, (err, addresses) => {
        if (err || !addresses?.length || addresses.some(a => !enderecoPublico(a.address))) return callback(new Error('fonte_nao_publica'));
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      }),
    }, res => {
      // Não seguir redirecionamentos: o novo destino requer revisão do manifesto.
      if (res.statusCode !== 200) { res.resume(); req.destroy(new Error('download_recusado')); return; }
      const partes = []; let tamanho = 0;
      res.on('data', chunk => {
        tamanho += chunk.length;
        if (tamanho > limite) req.destroy(new Error('download_limite'));
        else partes.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => tamanho > 0 && tamanho <= limite ? resolve(Buffer.concat(partes)) : reject(new Error('download_invalido')));
    });
    req.on('error', reject); req.on('close', () => clearTimeout(timer)); req.end();
  });
}
