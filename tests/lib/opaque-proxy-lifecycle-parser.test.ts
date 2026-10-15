import {test, expect} from 'bun:test';
import {parseConnectRequest, ConnectRequestError} from '../../src/lib/opaque-proxy-lifecycle/connect-request';
const authority='target.invalid:443';
const auth='Basic synthetic-local-session-fixture';
const valid=`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: ${auth}`;
test('strict local parser accepts explicit CONNECT with matching single Host and capability',()=>{
  expect(parseConnectRequest(Buffer.from(valid))).toEqual({authority,authorization:auth});
});
const invalid: Array<[string,string]> = [
  ['missing Host', `CONNECT ${authority} HTTP/1.1\r\nProxy-Authorization: ${auth}`],
  ['duplicate Host', valid+`\r\nHost: ${authority}`],
  ['ambiguous Host', valid.replace(`Host: ${authority}`, 'Host: other.invalid:443')],
  ['duplicate authorization', valid+`\r\nProxy-Authorization: ${auth}`],
  ['folded line', valid+'\r\n extra: value'],
  ['NUL value', valid+'\r\nX: abc\0def'],
  ['bare LF', valid.replace('\r\n','\n')],
  ['bare CR', valid+'\rX: bad'],
  ['tab header value', valid+'\r\nX: abc\tdef'],
  ['content length zero', valid+'\r\nContent-Length: 0'],
  ['content length body', valid+'\r\nContent-Length: 5'],
  ['transfer encoding', valid+'\r\nTransfer-Encoding: chunked'],
  ['unsupported method', valid.replace('CONNECT','GET')],
  ['authority path', valid.replace(authority,authority+'/path')],
  ['request line over limit', `CONNECT ${'a'.repeat(2050)}:443 HTTP/1.1`],
  ['line over limit', valid+'\r\nX: '+'a'.repeat(4096)],
  ['header byte limit', valid+'\r\nX: '+'a'.repeat(8192)],
  ['header line limit', valid+'\r\nX: a'.repeat(63)],
];
for(const [name,header] of invalid) test(`strict local parser rejects ${name}`,()=>{
  expect(()=>parseConnectRequest(Buffer.from(header))).toThrow(ConnectRequestError);
});
