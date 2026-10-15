import {validateAuthority} from '../opaque-proxy-tunnel';

export class ConnectRequestError extends Error {
  constructor(readonly status: string) {super('Rejected local proxy request');}
}
export interface ConnectRequest {authority: string; authorization: string | undefined;}
/** Strict local CONNECT header only. Never parses target TLS/application bytes. */
export function parseConnectRequest(header: Buffer): ConnectRequest {
  if (header.length > 8192) throw new ConnectRequestError('431 Request Header Fields Too Large');
  const text = header.toString('latin1');
  if (/[^\x20-\x7e\r\n]/.test(text) || /(?<!\r)\n|\r(?!\n)/.test(text)) throw new ConnectRequestError('400 Bad Request');
  const lines = text.split('\r\n');
  if (lines.length > 64 || lines[0].length > 2048 || lines.some(line => line.length > 4096)) throw new ConnectRequestError('431 Request Header Fields Too Large');
  const request = /^([A-Z]+) ([^ ]+) HTTP\/1\.[01]$/.exec(lines[0]);
  if (!request) throw new ConnectRequestError('400 Bad Request');
  if (request[1] !== 'CONNECT') throw new ConnectRequestError('405 Method Not Allowed');
  const authority = request[2];
  try {validateAuthority(authority);} catch {throw new ConnectRequestError('400 Bad Request');}
  let host: string | undefined, authorization: string | undefined;
  for (const line of lines.slice(1)) {
    const field = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+): *([\x20-\x7e]*?) *$/.exec(line);
    if (!field) throw new ConnectRequestError('400 Bad Request');
    const name = field[1].toLowerCase(), value = field[2];
    if (name === 'content-length' || name === 'transfer-encoding') throw new ConnectRequestError('400 Bad Request');
    if (name === 'host') {
      if (host !== undefined || value !== authority) throw new ConnectRequestError('400 Bad Request');
      host = value;
    }
    if (name === 'proxy-authorization') {
      if (authorization !== undefined) throw new ConnectRequestError('407 Proxy Authentication Required');
      authorization = value;
    }
  }
  if (host === undefined) throw new ConnectRequestError('400 Bad Request');
  return {authority, authorization};
}
