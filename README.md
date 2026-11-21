# Spanish company data MCP server (SpainCompanyAPI)

Official [MCP](https://modelcontextprotocol.io) server for [SpainCompanyAPI](https://spaincompanyapi.com) (APIEmpresas.es): Spanish company data for Claude, Cursor, VS Code and any MCP-compatible assistant. Look up companies by tax ID (CIF/NIF), verify them (KYB), check a list of invoice recipients, and get directors, registry filings (BORME), sanctions screening, public contracts, grants and open tenders.

Ask in plain language ("Is Mercadona active and who are its directors?", "Find the tax IDs of these 40 companies", "Check these Spanish customers before I invoice them") and the assistant calls the API with your key.

- **Free API key:** 100 requests, no card required. [Sign up](https://spaincompanyapi.com/register?intent=api&plan=free&source=mcp)
- **API documentation:** [spaincompanyapi.com/docs](https://spaincompanyapi.com/docs)
- **Coverage:** over 4.7 million Spanish companies, updated every working day from the Commercial Registry gazette (BORME) and other public registers.

> Versión en español al final de este documento.

## Tools

| Tool | What it does | Plan |
|---|---|---|
| `get_company` | Company by tax ID: legal name, status, incorporation date, province, CNAE activity, legal form (ISO 20275) and LEI; whether the Tax Agency has revoked its tax ID (`tax_id_revocation`); registered office, sole shareholder, parent company and directors depending on plan | Free (reduced data), Pro |
| `search_companies` | Search companies by name | Free |
| `verify_company` | KYB check (`/companies/verify`): the company exists and is operating, the name and the director (or sole shareholder) match and, if asked, the EU VAT number is in VIES; with legal form, LEI, parent and sole shareholder; fails if the Tax Agency has revoked the tax ID (2 requests) | Pro |
| `find_cif_by_name` | Name to tax ID, up to 100 at a time, with an optional province to break ties (only matches are charged) | Pro |
| `verify_invoice_recipients` | Checks a list of customers (up to 100) before invoicing them (`/companies/verify/batch`): legal name and registered office, status and `invoice_hint` ok / revisar (review) / no_facturar (do not invoice), with the reasons; with `vat`, also VIES (up to 20). Only companies found are charged | Pro |
| `get_borme_history` | Events published in the BORME | Pro |
| `get_risk_profile` | Risk profile based on the BORME | Business |
| `get_public_contracts` | Public contracts awarded | Business |
| `get_subsidies` | Public grants from the national grants database (BDNS) since 2022: summary by year, instrument and call, and the individual awards | Business |
| `search_tenders` | Open public tenders: by keywords, CPV, province, type and amount, or similar to what a company has already won (`cif`) | Business |
| `check_sanctions` | EU, UN and OFAC sanctions lists: a company and its directors (`cif`) or a name (`name`), with the strength of each match | Business |
| `get_usage` | Plan, requests left and credit balance (free; not available in the sandbox) | All |

All tools are read-only. Each call uses requests from your plan, as with the API.

## Installation

1. Create a free account (100 requests, no card) at [spaincompanyapi.com](https://spaincompanyapi.com/register?intent=api&plan=free&source=mcp) and copy your API key from the dashboard.
2. Add the server to your client (requires Node.js 18 or later).

### Claude Desktop

In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "apiempresas": {
      "command": "npx",
      "args": ["-y", "apiempresas-mcp"],
      "env": { "APIEMPRESAS_API_KEY": "your_api_key" }
    }
  }
}
```

### Claude Code

```bash
claude mcp add apiempresas --env APIEMPRESAS_API_KEY=your_api_key -- npx -y apiempresas-mcp
```

### Cursor

In `~/.cursor/mcp.json` (or `.cursor/mcp.json` in your project), the same `mcpServers` block as for Claude Desktop.

### VS Code

In `.vscode/mcp.json`:

```json
{
  "servers": {
    "apiempresas": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "apiempresas-mcp"],
      "env": { "APIEMPRESAS_API_KEY": "your_api_key" }
    }
  }
}
```

### Remote server (nothing to install)

Clients that support remote MCP servers can connect to `https://spaincompanyapi.com/api/mcp` (also `https://apiempresas.es/api/mcp`) with the `X-API-KEY` header. Without a key, name search and basic company data still work, with a daily limit.

### Testing at no cost

With `APIEMPRESAS_BASE_URL=https://spaincompanyapi.com/api/sandbox/v1` calls do not use requests (only the test tax IDs A15075062 and B00000000 work). With `APIEMPRESAS_BASE_URL=https://spaincompanyapi.com/api/v1` you use the live API with error messages in English; the default is `https://apiempresas.es/api/v1`.

## Good to know

- Registry status, scoring and risk profile are worked out by SpainCompanyAPI from the BORME: they are not a certificate from the Commercial Registry.
- Not covered: ultimate beneficial owners, PEP screening, credit scores, full annual accounts and sole traders (autónomos).
- Pricing: Free 100 requests; Pro €19/month (3,000/month); Business €49/month (10,000/month); credit packs without subscription. VAT not included. Details at [spaincompanyapi.com](https://spaincompanyapi.com/spanish-company-data-api).

## Links

- Website: [spaincompanyapi.com](https://spaincompanyapi.com)
- API documentation: [spaincompanyapi.com/docs](https://spaincompanyapi.com/docs)
- MCP setup guide: [spaincompanyapi.com/docs#mcp](https://spaincompanyapi.com/docs#mcp)
- Support: soporte@apiempresas.es

## License

MIT

---

## En español

Servidor MCP oficial de [APIEmpresas.es](https://apiempresas.es): datos de empresas españolas para Claude, Cursor, VS Code y cualquier asistente compatible con MCP. Las herramientas son las de la tabla de arriba: empresa por CIF, búsqueda por nombre, verificación KYB, de nombre a CIF, validación del NIF de los clientes antes de facturar (`verify_invoice_recipients`), BORME, riesgo, contratos públicos, subvenciones, licitaciones abiertas y listas de sanciones.

```bash
claude mcp add apiempresas --env APIEMPRESAS_API_KEY=tu_api_key -- npx -y apiempresas-mcp
```

Crea una cuenta gratis (100 consultas, sin tarjeta) en [apiempresas.es](https://apiempresas.es/register?intent=api&plan=free&source=mcp). Para probar sin gastar consultas: `APIEMPRESAS_BASE_URL=https://apiempresas.es/api/sandbox/v1`. Documentación completa en [apiempresas.es/documentation](https://apiempresas.es/documentation).
