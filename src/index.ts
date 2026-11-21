#!/usr/bin/env node
/**
 * Servidor MCP de APIEmpresas.es
 *
 * Expone la API de datos de empresas españolas como herramientas de solo lectura para
 * asistentes de IA (Claude, Cursor, VS Code...). Usa la API key del propio usuario:
 * cada llamada gasta consultas de su plan, igual que si llamara a la API directamente.
 *
 * Variables de entorno:
 *   APIEMPRESAS_API_KEY   (obligatoria) clave de https://apiempresas.es/dashboard
 *   APIEMPRESAS_BASE_URL  (opcional) por defecto https://apiempresas.es/api/v1;
 *                         https://apiempresas.es/api/sandbox/v1 para pruebas sin coste
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

export const VERSION = '1.4.3';

const API_KEY = (process.env.APIEMPRESAS_API_KEY || '').trim();
const BASE_URL = (process.env.APIEMPRESAS_BASE_URL || 'https://apiempresas.es/api/v1').replace(/\/+$/, '');
const TIMEOUT_MS = 30_000;
/** Las respuestas grandes (historial del BORME, contratos) se recortan para no llenar el contexto. */
const MAX_CHARS = 60_000;

const SIGNUP_URL = 'https://apiempresas.es/register?intent=api&plan=free&source=mcp';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function texto(t: string, isError = false): ToolResult {
  return isError ? { content: [{ type: 'text', text: t }], isError: true } : { content: [{ type: 'text', text: t }] };
}

function json(data: unknown): ToolResult {
  let t = JSON.stringify(data, null, 2);
  if (t.length > MAX_CHARS) {
    t = t.slice(0, MAX_CHARS) + '\n… (respuesta recortada: pide menos resultados o una página concreta)';
  }
  return texto(t);
}

/** CIF/NIF en el formato que espera la API: sin espacios, guiones ni puntos y en mayúsculas. */
function limpiarCif(cif: string): string {
  return cif.replace(/[\s.\-]/g, '').toUpperCase();
}

const cifSchema = z
  .string()
  .min(9)
  .max(15)
  .describe('Spanish company tax ID (CIF/NIF), e.g. A46103834 (spaces and hyphens are accepted)');

/** Mensaje de error útil para el asistente y para la persona: qué pasó y qué hacer. */
function mensajeError(status: number, body: any): string {
  const partes: string[] = [];
  const b = body && typeof body === 'object' ? body : {};
  const primero = b.messages && typeof b.messages === 'object' ? Object.values(b.messages)[0] : '';
  const msg = b.message || b.detail || (typeof b.error === 'string' ? b.error : '') || (typeof primero === 'string' ? primero : '');
  const code: string = typeof b.code === 'string' ? b.code : '';
  partes.push(`Error ${status}${code ? ` (${code})` : ''}: ${msg || 'la API no ha devuelto detalle'}`);

  // Qué hacer, según el código estable de la API (13-10-2026)
  const plan = typeof b.required_plan === 'string' ? ` (necesita el plan ${b.required_plan === 'business' ? 'Business' : 'Pro'})` : '';
  const consejos: Record<string, string> = {
    API_KEY_MISSING: `Falta la API key. Se obtiene gratis en ${SIGNUP_URL} y se configura en APIEMPRESAS_API_KEY.`,
    API_KEY_INVALID: `La API key no es válida. Se obtiene gratis en ${SIGNUP_URL} y se configura en APIEMPRESAS_API_KEY.`,
    API_KEY_INACTIVE: 'La API key o la cuenta están desactivadas. Revísalo en el panel de APIEmpresas.',
    COUNTRY_NOT_ALLOWED: 'La API key no admite peticiones desde este país (se configura en el panel).',
    TEST_MODE_RESTRICTION: 'En el Sandbox solo valen los CIF de prueba A15075062 (encontrada) y B00000000 (no encontrada).',
    PLAN_RESTRICTION: `Este dato no está incluido en el plan actual de la cuenta${plan}.`,
    UPGRADE_REQUIRED: `Este dato no está incluido en el plan actual de la cuenta${plan}.`,
    QUOTA_EXCEEDED: 'Se han agotado las consultas del plan y no queda saldo. Reintentar no sirve.',
    TOO_MANY_REQUESTS: 'Demasiadas peticiones por segundo: espera un momento y vuelve a intentarlo.',
    IP_LIMIT_EXCEEDED: 'Se ha alcanzado el límite de seguridad por IP del plan Free.',
    PREVIEW_LIMIT_EXCEEDED: 'Se ha alcanzado el límite diario de vistas previas gratuitas. Vuelve mañana o mejora el plan.',
    COMPANY_NOT_FOUND: 'No hay ninguna empresa con ese CIF o nombre en la base de datos.',
    AUTONOMO_NOT_SUPPORTED: 'Es un DNI o NIE: la API solo tiene datos de sociedades, no de autónomos.',
    FAKE_CIF_NOT_ALLOWED: 'Es un CIF de prueba: en producción usa un CIF real (los de prueba solo valen en el Sandbox).',
    INVALID_CIF_FORMAT: 'El CIF no tiene un formato válido.',
    RISK_PROFILE_NOT_AVAILABLE: 'La empresa existe, pero no tiene perfil de riesgo calculado.',
  };
  if (code && consejos[code]) {
    partes.push(consejos[code]);
  } else if (status === 401) {
    partes.push(consejos.API_KEY_INVALID);
  } else if (status === 403) {
    partes.push('Este dato no está incluido en el plan actual de la cuenta.');
  }
  // Enlaces de compra que trae la propia API en los 403/429 (arriba o dentro de upsell_opportunities)
  const etiquetas: Record<string, string> = {
    starter_url: 'Bono de 1.000 créditos (pago único)',
    checkout_url: 'Mejorar plan',
    recharge_url: 'Recargar créditos',
    upgrade_url: 'Planes',
  };
  const up = b.upsell_opportunities && typeof b.upsell_opportunities === 'object' ? b.upsell_opportunities : {};
  const vistos = new Set<string>();
  for (const [k, etiqueta] of Object.entries(etiquetas)) {
    const url = (typeof b[k] === 'string' && b[k]) || (typeof up[k] === 'string' && up[k]) || '';
    if (url && !vistos.has(url)) {
      vistos.add(url);
      partes.push(`${etiqueta}: ${url}`);
    }
  }
  return partes.join('\n');
}

async function llamar(path: string, init: RequestInit = {}): Promise<ToolResult> {
  if (!API_KEY) {
    return texto(
      `Falta la API key de APIEmpresas. Crea una cuenta gratis (100 consultas, sin tarjeta) en ${SIGNUP_URL}, ` +
        'copia la clave del panel y ponla en la variable de entorno APIEMPRESAS_API_KEY de la configuración del servidor MCP.',
      true,
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      'X-API-KEY': API_KEY,
      Accept: 'application/json',
      'User-Agent': `apiempresas-mcp/${VERSION}`,
    };
    if (init.body) headers['Content-Type'] = 'application/json';

    const res = await fetch(`${BASE_URL}${path}`, { ...init, headers, signal: controller.signal });
    const tipo = res.headers.get('content-type') || '';
    const body: any = tipo.includes('application/json') ? await res.json().catch(() => null) : await res.text();

    if (!res.ok) {
      return texto(mensajeError(res.status, body), true);
    }
    return json(body);
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      return texto(`La API no respondió en ${TIMEOUT_MS / 1000} s. Prueba de nuevo en un momento.`, true);
    }
    return texto(`No se pudo conectar con la API (${BASE_URL}): ${e?.message || e}`, true);
  } finally {
    clearTimeout(timer);
  }
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    p.set(k, typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v));
  }
  return p.toString();
}

const soloLectura = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export function crearServidor(): McpServer {
  const server = new McpServer({ name: 'apiempresas', version: VERSION });

  server.registerTool(
    'get_company',
    {
      title: 'Spanish company by tax ID',
      description:
        "Record of ONE Spanish company when you already have its tax ID (CIF/NIF). Use it to find out whether it exists and is active, its legal name, legal form (with ISO 20275 code), LEI, CNAE activity code, province and incorporation date; on the Pro plan, also its registered office, revenue band, sole shareholder, parent company and, with include_directors, its current directors. On every plan it flags whether the Spanish Tax Agency has revoked (or reinstated) its tax ID according to the BOE gazette (tax_id_revocation): a revoked tax ID is not valid for tax purposes and banks cannot process payments to or from it. If you do not have the tax ID, use search_companies; to decide on onboarding (KYB), use verify_company. Uses 1 request. Búsqueda de empresa española por CIF.",
      inputSchema: {
        cif: cifSchema,
        include_directors: z
          .boolean()
          .optional()
          .describe('true to include current directors and officers (Pro and Business plans)'),
      },
      annotations: soloLectura,
    },
    async ({ cif, include_directors }) =>
      llamar(`/companies?${qs({ cif: limpiarCif(cif), admin: include_directors ? true : undefined })}`),
  );

  server.registerTool(
    'search_companies',
    {
      title: 'Search Spanish companies by name',
      description:
        "Searches Spanish companies by full or partial name and returns the candidates with their tax ID (CIF), province and status. Use it when you do NOT have the tax ID of a specific company; then call get_company with the chosen tax ID. To turn a long list of names into tax IDs, use find_cif_by_name instead. Buscar empresas españolas por nombre.",
      inputSchema: {
        query: z.string().min(2).describe('Full or partial company name'),
        limit: z.number().int().min(1).max(25).optional().describe('Maximum number of results (default 10)'),
      },
      annotations: soloLectura,
    },
    async ({ query, limit }) => llamar(`/companies/search?${qs({ q: query, multiple: true, limit: limit ?? 10 })}`),
  );

  server.registerTool(
    'verify_company',
    {
      title: 'KYB verification of a Spanish company',
      description:
        "One-call check to onboard a customer or supplier (KYB): verifies that the company exists and is operating, that the legal name you were given matches (name), that the signer is a current director or sole shareholder (person) and, if requested, the EU VAT number in VIES (vat). Returns fail if the Spanish Tax Agency has revoked its tax ID (flag TAX_ID_REVOKED). Returns flags and a pass / review / fail recommendation, plus legal form, LEI, parent company and sole shareholder. Use it to make a decision; to just look up data, use get_company. Pro plan; uses 2 requests. Verificación KYB de una empresa española.",
      inputSchema: {
        cif: cifSchema,
        name: z.string().optional().describe('Legal name declared by the customer, to check that it matches'),
        person: z.string().optional().describe('Name of the person signing, to check whether they are a director or the sole shareholder'),
        vat: z.boolean().optional().describe('true to also check the EU VAT number in VIES (intra-EU trader)'),
      },
      annotations: soloLectura,
    },
    async ({ cif, name, person, vat }) =>
      llamar(`/companies/verify?${qs({ cif: limpiarCif(cif), name, person, vat: vat ? true : undefined })}`),
  );

  server.registerTool(
    'find_cif_by_name',
    {
      title: 'Company names to tax IDs',
      description:
        "Turns a LIST of Spanish company names (up to 100) into their tax IDs (CIF), with a match, ambiguous or no_match result for each. Use it to complete customer or supplier sheets that only have the name. Only matches use a request. For a single name, use search_companies. Pro plan. De nombre de empresa a CIF.",
      inputSchema: {
        names: z.array(z.string().min(2)).min(1).max(100).describe('Company names'),
        province: z
          .string()
          .optional()
          .describe('Province (e.g. VALENCIA) to break ties between companies with the same name; applies to all names'),
      },
      annotations: soloLectura,
    },
    async ({ names, province }) =>
      llamar('/companies/reconcile', {
        method: 'POST',
        body: JSON.stringify({ items: names.map((name) => (province ? { name, province } : { name })) }),
      }),
  );

  // 1.4.0 (26-10-2026): igual que en el servidor remoto (app/Libraries/McpServer.php)
  server.registerTool(
    'verify_invoice_recipients',
    {
      title: 'Check invoice recipients\' tax IDs',
      description:
        "Checks a LIST of Spanish customers (up to 100) before invoicing them (VERI*FACTU, e-invoicing): for each tax ID, whether the format is valid, whether the company is registered, its legal name and registered office, its status and, if you pass the name you hold, whether it matches. Returns invoice_hint ok / revisar (review) / no_facturar (do not invoice) with the reasons (struck off, absorbed, insolvent, tax ID revoked by the Tax Agency, name mismatch, sample tax ID...). Use it to review the customer base of an invoicing program or ERP; to onboard a single customer in more detail, use verify_company. It does not replace the Tax Agency census. Pro or Business plan, or credits; uses 1 request per company found (tax IDs not found are free). Validar el NIF de los clientes antes de facturar.",
      inputSchema: {
        items: z
          .array(
            z.object({
              cif: z.string().min(1).describe('Customer tax ID (CIF, DNI or NIE)'),
              name: z.string().optional().describe('Legal name you hold, to check that it matches the registered one'),
              ref: z.string().optional().describe('Your own customer identifier; returned as is'),
            }),
          )
          .min(1)
          .max(100)
          .describe('Customers to check'),
        vat: z.boolean().optional().describe('true to also check the EU VAT number in VIES (only with 20 customers or fewer)'),
      },
      annotations: soloLectura,
    },
    async ({ items, vat }) => {
      if (vat && items.length > 20) {
        return texto('La comprobación en VIES (vat) solo admite 20 clientes por llamada. Quita vat o divide la lista.', true);
      }
      return llamar('/companies/verify/batch', {
        method: 'POST',
        body: JSON.stringify(vat ? { items, vat: true } : { items }),
      });
    },
  );

  server.registerTool(
    'get_borme_history',
    {
      title: 'BORME registry history',
      description:
        "Every event a Spanish company has published in the BORME (Commercial Registry gazette), with date and PDF: incorporation, director appointments and removals, capital increases, changes of address or name, dissolution, insolvency... Use it for the company history and recent changes; for the current status, get_company is enough. Pro plan. Historial de actos del BORME.",
      inputSchema: { cif: cifSchema },
      annotations: soloLectura,
    },
    async ({ cif }) => llamar(`/companies/borme?${qs({ cif: limpiarCif(cif) })}`),
  );

  server.registerTool(
    'get_risk_profile',
    {
      title: 'Risk profile',
      description:
        "Risk level of a Spanish company and its reasons, worked out from its BORME publications (insolvency, dissolution, closed registry sheet, accounts not filed, director changes...). Use it before extending credit or signing with a supplier. Business plan. Perfil de riesgo de una empresa.",
      inputSchema: { cif: cifSchema },
      annotations: soloLectura,
    },
    async ({ cif }) => llamar(`/companies/risk-profile?${qs({ cif: limpiarCif(cif) })}`),
  );

  server.registerTool(
    'get_public_contracts',
    {
      title: 'Public contracts awarded',
      description:
        "Public sector contracts awarded to a Spanish company (Spanish Public Procurement Platform): contracting body, subject, amount and date. Business plan. Contratos públicos adjudicados.",
      inputSchema: {
        cif: cifSchema,
        page: z.number().int().min(1).optional().describe('Page (default 1)'),
        limit: z.number().int().min(1).max(50).optional().describe('Contracts per page (default 20)'),
      },
      annotations: soloLectura,
    },
    async ({ cif, page, limit }) =>
      llamar(`/companies/contracts?${qs({ cif: limpiarCif(cif), page: page ?? 1, limit: limit ?? 20 })}`),
  );

  // 1.3.0 (20-10-2026): igual que en el servidor remoto (app/Libraries/McpServer.php)
  server.registerTool(
    'get_subsidies',
    {
      title: 'Public grants and subsidies',
      description: "Grants, loans, guarantees and tax benefits awarded to a Spanish company according to the national grants database (BDNS), since 2022, Kit Digital included: summary by year, by instrument and the largest calls, plus the list of awards. Use it to research public funding or to see how much public money a company receives. Business plan; uses 1 request. Subvenciones y ayudas públicas.",
      inputSchema: {
        cif: cifSchema,
        year: z.number().int().min(2000).optional().describe('Only awards from that year'),
        limit: z.number().int().min(1).max(50).optional().describe('Awards per page (default 20)'),
      },
      annotations: soloLectura,
    },
    async ({ cif, year, limit }) =>
      llamar(`/companies/subsidies?${qs({ cif: limpiarCif(cif), year, limit: limit ?? 20 })}`),
  );

  server.registerTool(
    'search_tenders',
    {
      title: 'Open public tenders in Spain',
      description: "Public tenders in Spain that are still OPEN for bids (Spanish Public Procurement Platform and regional platforms): title, contracting body, province, amount, bid deadline, CPV and link to apply. Filter by words in the title (query, in Spanish), CPV, province, type (supplies, services, works) and amount. With cif, returns open tenders similar to the contracts that company has already won: use it for \"which tenders could this company bid for?\". Business plan; uses 1 request. Licitaciones públicas abiertas.",
      inputSchema: {
        query: z.string().min(3).optional().describe('Words that must appear in the title, in Spanish, e.g. "limpieza colegios"'),
        cpv: z.string().optional().describe('CPV code or its prefix, comma-separated (e.g. "72,48" for IT)'),
        province: z.string().optional().describe('Province of the contracting body, e.g. Madrid, Barcelona, Bizkaia'),
        type: z.enum(['supplies', 'services', 'works']).optional().describe('Contract type'),
        min_amount: z.number().min(0).optional().describe('Minimum amount excluding VAT (euros)'),
        max_amount: z.number().min(0).optional().describe('Maximum amount excluding VAT (euros)'),
        cif: z.string().optional().describe('Tax ID of a company: tenders similar to what it has already won'),
        limit: z.number().int().min(1).max(50).optional().describe('Number of tenders (default 20)'),
      },
      annotations: soloLectura,
    },
    async ({ query, cpv, province, type, min_amount, max_amount, cif, limit }) =>
      llamar(`/tenders?${qs({ q: query, cpv, province, type, min_amount, max_amount, cif: cif ? limpiarCif(cif) : undefined, limit: limit ?? 20 })}`),
  );

  server.registerTool(
    'check_sanctions',
    {
      title: 'Sanctions screening (EU, UN, OFAC)',
      description: "Checks whether a Spanish company (by cif, together with its current directors) or a single name (name) appears on the EU, UN and OFAC (US) sanctions lists. Returns each match with its strength (strong or possible), list, programme, date, country and date of birth so it can be confirmed or ruled out: a similar name is not a confirmed match. Use it when onboarding customers or suppliers (KYB, anti-money laundering). Business plan; uses 1 request. Listas de sanciones.",
      inputSchema: {
        cif: z.string().optional().describe('Company tax ID (the legal name and the directors are checked)'),
        name: z.string().min(3).optional().describe('Name of a person or entity, instead of cif'),
        type: z.enum(['person', 'entity', 'any']).optional().describe('With name: person, entity or any'),
      },
      annotations: soloLectura,
    },
    async ({ cif, name, type }) => {
      if (!cif && !name) {
        return texto('Indica el CIF de una empresa (cif) o un nombre de al menos 3 letras (name).', true);
      }
      return llamar(`/sanctions/screen?${qs(cif ? { cif: limpiarCif(cif) } : { name, type })}`);
    },
  );

  server.registerTool(
    'get_usage',
    {
      title: 'Account usage',
      description: "The user's plan, requests used and available, and credit balance. Uses no requests. Use it when a tool says the quota has run out. Consumo de la cuenta.",
      inputSchema: {},
      annotations: soloLectura,
    },
    async () => llamar('/usage'),
  );

  return server;
}

async function main() {
  const server = crearServidor();
  await server.connect(new StdioServerTransport());
  // stdout es el canal del protocolo: los avisos van a stderr
  if (!API_KEY) {
    console.error(`[apiempresas-mcp] Falta APIEMPRESAS_API_KEY. Clave gratis en ${SIGNUP_URL}`);
  }
}

main().catch((e) => {
  console.error('[apiempresas-mcp] Error al arrancar:', e);
  process.exit(1);
});
