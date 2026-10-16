// Prueba de humo: arranca el servidor MCP por stdio contra una API simulada y
// comprueba herramientas, peticiones y errores. Uso: npm test
import http from 'node:http';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const vistas = [];
const api = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    vistas.push({ method: req.method, url: req.url, key: req.headers['x-api-key'], ua: req.headers['user-agent'], body });
    const u = new URL(req.url, 'http://x');
    const send = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (u.pathname === '/api/v1/companies' && u.searchParams.get('cif') === 'A46103834') {
      return send(200, { success: true, data: { cif: 'A46103834', name: 'MERCADONA SA', status: 'ACTIVA' } });
    }
    if (u.pathname === '/api/v1/companies') {
      return send(404, { success: false, code: 'COMPANY_NOT_FOUND', message: 'Empresa no encontrada' });
    }
    if (u.pathname === '/api/v1/companies/risk-profile') {
      // Forma real de un 403 de plan: el enlace va dentro de upsell_opportunities
      return send(403, {
        success: false, error: 'PLAN_RESTRICTION', code: 'PLAN_RESTRICTION', message: 'Endpoint disponible en Business',
        required_plan: 'business', current_plan: 'free',
        upsell_opportunities: { checkout_url: 'https://apiempresas.es/billing?plan=business' },
      });
    }
    if (u.pathname === '/api/v1/companies/borme') {
      return send(429, {
        success: false, code: 'QUOTA_EXCEEDED', message: 'Has consumido las 100 consultas gratuitas',
        starter_url: 'https://apiempresas.es/billing/checkout_bonus?credits=1000&source=api_429_quota',
      });
    }
    if (u.pathname === '/api/v1/companies/reconcile') {
      return send(200, { success: true, data: JSON.parse(body).items.map((i) => ({ name: i.name, status: 'match' })), meta: {} });
    }
    if (u.pathname === '/api/v1/companies/search') {
      return send(200, { success: true, data: [{ cif: 'A46103834', name: 'MERCADONA SA' }], meta: {} });
    }
    if (u.pathname === '/api/v1/usage') {
      return send(200, { success: true, data: { plan: 'free', used: 3, quota: 100 } });
    }
    send(500, { message: 'ruta no simulada ' + u.pathname });
  });
});
await new Promise((r) => api.listen(0, r));
const base = `http://127.0.0.1:${api.address().port}/api/v1`;

async function conectar(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/index.js'],
    env: { PATH: process.env.PATH, ...env },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'smoke', version: '0' });
  await client.connect(transport);
  return client;
}

const txt = (r) => r.content.map((c) => c.text).join('\n');

// 1) Con clave
const c = await conectar({ APIEMPRESAS_API_KEY: 'clave-test', APIEMPRESAS_BASE_URL: base });
const { tools } = await c.listTools();
const nombres = tools.map((t) => t.name).sort();
assert.deepEqual(nombres, ['find_cif_by_name', 'get_borme_history', 'get_company', 'get_public_contracts', 'get_risk_profile', 'get_usage', 'search_companies', 'verify_company']);
assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true), 'todas de solo lectura');

let r = await c.callTool({ name: 'get_company', arguments: { cif: 'a-46.103 834', include_directors: true } });
assert.ok(!r.isError, txt(r));
assert.match(txt(r), /MERCADONA/);
let v = vistas.at(-1);
assert.equal(v.url, '/api/v1/companies?cif=A46103834&admin=true');
assert.equal(v.key, 'clave-test');
assert.match(v.ua, /^apiempresas-mcp\//);

r = await c.callTool({ name: 'get_company', arguments: { cif: 'B00000000' } });
assert.equal(r.isError, true);
assert.match(txt(r), /404 \(COMPANY_NOT_FOUND\)/);

r = await c.callTool({ name: 'get_risk_profile', arguments: { cif: 'A46103834' } });
assert.equal(r.isError, true);
assert.match(txt(r), /no está incluido en el plan actual de la cuenta \(necesita el plan Business\)/);
assert.match(txt(r), /Mejorar plan: https:\/\/apiempresas\.es\/billing\?plan=business/);

r = await c.callTool({ name: 'get_borme_history', arguments: { cif: 'A46103834' } });
assert.equal(r.isError, true);
assert.match(txt(r), /Bono de 1\.000 créditos/);

r = await c.callTool({ name: 'find_cif_by_name', arguments: { names: ['Mercadona', 'Inditex'] } });
assert.ok(!r.isError, txt(r));
v = vistas.at(-1);
assert.equal(v.method, 'POST');
assert.deepEqual(JSON.parse(v.body), { items: [{ name: 'Mercadona' }, { name: 'Inditex' }] });

r = await c.callTool({ name: 'search_companies', arguments: { query: 'mercadona' } });
assert.ok(!r.isError);
assert.equal(vistas.at(-1).url, '/api/v1/companies/search?q=mercadona&multiple=true&limit=10');

r = await c.callTool({ name: 'get_usage', arguments: {} });
assert.ok(!r.isError);
await c.close();

// 2) Sin clave: no llama a la API y explica cómo conseguirla
const antes = vistas.length;
const c2 = await conectar({ APIEMPRESAS_BASE_URL: base });
r = await c2.callTool({ name: 'get_company', arguments: { cif: 'A46103834' } });
assert.equal(r.isError, true);
assert.match(txt(r), /Falta la API key/);
assert.equal(vistas.length, antes);
await c2.close();

api.close();
console.log(`OK: ${nombres.length} herramientas, ${vistas.length} llamadas a la API simulada`);
