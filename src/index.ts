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

export const VERSION = '1.1.0';

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
  .describe('CIF/NIF de la empresa española, p. ej. A46103834 (se aceptan espacios y guiones)');

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
      title: 'Empresa por CIF',
      description:
        'Datos de una empresa española a partir de su CIF/NIF: razón social, estado (activa, extinguida, en concurso…), ' +
        'fecha de constitución, provincia, municipio, CNAE, forma jurídica (con código ISO 20275) y código LEI y, según el ' +
        'plan, domicilio completo, tramo de facturación, socio único (ownership), matriz del grupo según GLEIF (group) y ' +
        'administradores (include_directors). Gasta 1 consulta. El estado lo calcula APIEmpresas a partir del BORME; ' +
        'no es un certificado del Registro Mercantil. Spanish company lookup by tax ID.',
      inputSchema: {
        cif: cifSchema,
        include_directors: z
          .boolean()
          .optional()
          .describe('true para incluir administradores y cargos vigentes (planes Pro y Business)'),
      },
      annotations: soloLectura,
    },
    async ({ cif, include_directors }) =>
      llamar(`/companies?${qs({ cif: limpiarCif(cif), admin: include_directors ? true : undefined })}`),
  );

  server.registerTool(
    'search_companies',
    {
      title: 'Buscar empresas por nombre',
      description:
        'Busca empresas españolas por nombre o razón social y devuelve las coincidencias con su CIF. ' +
        'Útil cuando no se conoce el CIF. Search Spanish companies by name.',
      inputSchema: {
        query: z.string().min(2).describe('Nombre o parte del nombre de la empresa'),
        limit: z.number().int().min(1).max(25).optional().describe('Número máximo de resultados (por defecto 10)'),
      },
      annotations: soloLectura,
    },
    async ({ query, limit }) => llamar(`/companies/search?${qs({ q: query, multiple: true, limit: limit ?? 10 })}`),
  );

  server.registerTool(
    'verify_company',
    {
      title: 'Verificación KYB',
      description:
        'Verificación KYB de una empresa en una sola llamada: si existe y está activa, si el nombre declarado coincide ' +
        'y si una persona es administradora o el socio único, con alertas y una recomendación (pass / review / fail). ' +
        'Devuelve también la forma jurídica, el LEI, la matriz del grupo y el socio único. ' +
        'Plan Pro o superior; gasta 2 consultas. KYB check for a Spanish company.',
      inputSchema: {
        cif: cifSchema,
        name: z.string().optional().describe('Razón social que ha declarado el cliente, para comprobar que coincide'),
        person: z.string().optional().describe('Nombre de la persona que firma, para comprobar si es administradora o socia única'),
        vat: z.boolean().optional().describe('true para comprobar además el NIF-IVA en VIES (operador intracomunitario)'),
      },
      annotations: soloLectura,
    },
    async ({ cif, name, person, vat }) =>
      llamar(`/companies/verify?${qs({ cif: limpiarCif(cif), name, person, vat: vat ? true : undefined })}`),
  );

  server.registerTool(
    'find_cif_by_name',
    {
      title: 'De nombre a CIF',
      description:
        'Encuentra el CIF de una lista de empresas a partir de sus nombres (hasta 100). Cada resultado es match, ' +
        'ambiguous o no_match; solo los match gastan consulta. Plan Pro o superior. Útil para completar hojas de clientes.',
      inputSchema: {
        names: z.array(z.string().min(2)).min(1).max(100).describe('Nombres de empresas'),
        province: z
          .string()
          .optional()
          .describe('Provincia (p. ej. VALENCIA) para desempatar entre empresas con el mismo nombre; se aplica a todos'),
      },
      annotations: soloLectura,
    },
    async ({ names, province }) =>
      llamar('/companies/reconcile', {
        method: 'POST',
        body: JSON.stringify({ items: names.map((name) => (province ? { name, province } : { name })) }),
      }),
  );

  server.registerTool(
    'get_borme_history',
    {
      title: 'Historial del BORME',
      description:
        'Actos publicados en el BORME (Boletín Oficial del Registro Mercantil) de una empresa: constitución, ' +
        'nombramientos y ceses, ampliaciones de capital, cambios de domicilio, disolución, concurso… Plan Pro o superior.',
      inputSchema: { cif: cifSchema },
      annotations: soloLectura,
    },
    async ({ cif }) => llamar(`/companies/borme?${qs({ cif: limpiarCif(cif) })}`),
  );

  server.registerTool(
    'get_risk_profile',
    {
      title: 'Perfil de riesgo',
      description:
        'Perfil de riesgo de una empresa calculado a partir de sus publicaciones en el BORME (concursos, disoluciones, ' +
        'cierres de hoja, cambios de administradores…), con nivel y explicación. Plan Business.',
      inputSchema: { cif: cifSchema },
      annotations: soloLectura,
    },
    async ({ cif }) => llamar(`/companies/risk-profile?${qs({ cif: limpiarCif(cif) })}`),
  );

  server.registerTool(
    'get_public_contracts',
    {
      title: 'Contratos públicos',
      description:
        'Contratos del sector público adjudicados a una empresa (Plataforma de Contratación del Sector Público). Plan Business.',
      inputSchema: {
        cif: cifSchema,
        page: z.number().int().min(1).optional().describe('Página (por defecto 1)'),
        limit: z.number().int().min(1).max(50).optional().describe('Contratos por página (por defecto 20)'),
      },
      annotations: soloLectura,
    },
    async ({ cif, page, limit }) =>
      llamar(`/companies/contracts?${qs({ cif: limpiarCif(cif), page: page ?? 1, limit: limit ?? 20 })}`),
  );

  server.registerTool(
    'get_usage',
    {
      title: 'Consumo de la cuenta',
      description: 'Plan de la cuenta, consultas usadas y disponibles, y saldo de créditos. No gasta consultas. No funciona en el Sandbox.',
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
