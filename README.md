# APIEmpresas MCP

Servidor [MCP](https://modelcontextprotocol.io) oficial de [APIEmpresas.es](https://apiempresas.es): datos de empresas españolas para Claude, Cursor, VS Code y cualquier asistente compatible con MCP.

Pregunta en lenguaje natural ("¿Mercadona está activa y quiénes son sus administradores?", "saca el CIF de estas 40 empresas", "¿esta empresa ha tenido un concurso?") y el asistente consulta la API con tu clave.

## Herramientas

| Herramienta | Qué hace | Plan |
|---|---|---|
| `get_company` | Empresa por CIF: razón social, estado, constitución, provincia, CNAE, forma jurídica (ISO 20275) y LEI; domicilio, socio único, matriz del grupo y administradores según plan | Free (datos recortados), Pro |
| `search_companies` | Buscar empresas por nombre | Free |
| `verify_company` | Verificación KYB: existe, activa, nombre y administrador (o socio único) coinciden y, si se pide, NIF-IVA en VIES; con forma jurídica, LEI, matriz y socio único (2 consultas) | Pro |
| `find_cif_by_name` | De nombre a CIF, hasta 100 a la vez, con provincia opcional para desempatar (solo cobra las coincidencias) | Pro |
| `get_borme_history` | Actos publicados en el BORME | Pro |
| `get_risk_profile` | Perfil de riesgo a partir del BORME | Business |
| `get_public_contracts` | Contratos públicos adjudicados | Business |
| `get_usage` | Plan, consultas disponibles y saldo de créditos (gratis; no funciona en el Sandbox) | Todos |

Todas son de solo lectura. Cada llamada gasta consultas de tu plan, igual que la API.

## Instalación

1. Crea una cuenta gratis (100 consultas, sin tarjeta) en [apiempresas.es](https://apiempresas.es/register?intent=api&plan=free&source=mcp) y copia tu API key del panel.
2. Añade el servidor a tu cliente (necesita Node.js 18 o superior).

### Claude Desktop

En `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "apiempresas": {
      "command": "npx",
      "args": ["-y", "apiempresas-mcp"],
      "env": { "APIEMPRESAS_API_KEY": "tu_api_key" }
    }
  }
}
```

### Claude Code

```bash
claude mcp add apiempresas --env APIEMPRESAS_API_KEY=tu_api_key -- npx -y apiempresas-mcp
```

### Cursor

En `~/.cursor/mcp.json` (o `.cursor/mcp.json` en el proyecto), el mismo bloque `mcpServers` que en Claude Desktop.

### VS Code

En `.vscode/mcp.json`:

```json
{
  "servers": {
    "apiempresas": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "apiempresas-mcp"],
      "env": { "APIEMPRESAS_API_KEY": "tu_api_key" }
    }
  }
}
```

### Pruebas sin coste

Con `APIEMPRESAS_BASE_URL=https://apiempresas.es/api/sandbox/v1` las llamadas no gastan consultas (solo admite los CIF de prueba A15075062 y B00000000).

## Qué conviene saber

- El estado registral, el scoring y el perfil de riesgo los calcula APIEmpresas a partir del BORME: no son un certificado del Registro Mercantil.
- No cubre titular real, listas de sanciones o PEP, ni empresarios individuales (autónomos).
- Precios: Free 100 consultas; Pro 19 €/mes (3.000/mes); Business 49 €/mes (10.000/mes); bonos sin suscripción desde 9 €. IVA no incluido. Detalle en [apiempresas.es](https://apiempresas.es/#precios).
- Documentación completa de la API: [apiempresas.es/documentation](https://apiempresas.es/documentation).

## English

Official MCP server for [APIEmpresas.es](https://apiempresas.es), a REST API for Spanish company data: lookup by CIF (tax ID), name search, KYB verification, directors, BORME (Commercial Registry gazette) filings, public contracts and risk profile. Get a free API key (100 requests) at apiempresas.es and run `npx -y apiempresas-mcp` with `APIEMPRESAS_API_KEY` set.

## Licencia

MIT
