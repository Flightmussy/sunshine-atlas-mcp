# Sunshine Atlas MCP server

A remote, read-only [Model Context Protocol](https://modelcontextprotocol.io/) server that answers
**"where is it sunny?"** with data: monthly 0–100 Sunshine Scores, day/night temperatures,
rainfall and sea temperature for **3,833 destinations — every one with its own airport** —
from long-term climate normals. It serves the same open dataset published at
[sunshineatlas.com/data](https://sunshineatlas.com/data/) (CC BY 4.0, [DOI 10.5281/zenodo.21322408](https://doi.org/10.5281/zenodo.21322408)).

**Live endpoint (no key, no signup):**

```
https://sunshineatlas.com/api/mcp
```

Listed in the [official MCP registry](https://registry.modelcontextprotocol.io/) as
`com.sunshineatlas/sunshine-atlas`. Docs page: [sunshineatlas.com/mcp](https://sunshineatlas.com/mcp/).

## Tools

| Tool | Answers |
|---|---|
| `find_sunny_destinations` | "Where is it sunny (and warm) in November?" — ranked by that month's Sunshine Score, filterable by continent/country, minimum day temperature, swimmable sea (≥21 °C), population |
| `get_destination_climate` | "When is the best time to visit Faro?" — full 12-month climate card for one destination (city, "city, country" or IATA code) |
| `compare_destinations` | "Algarve or Crete in October?" — side-by-side comparison of 2–5 destinations with a one-line verdict |

Every result carries attribution and citable `sunshineatlas.com` destination URLs.

## Connect a client

**Claude Code**

```sh
claude mcp add --transport http sunshine-atlas https://sunshineatlas.com/api/mcp
```

**Claude (custom connector), ChatGPT connectors, or any Streamable-HTTP client** — add the URL
`https://sunshineatlas.com/api/mcp`.

**Generic JSON config (Cursor, etc.)**

```json
{
  "mcpServers": {
    "sunshine-atlas": {
      "url": "https://sunshineatlas.com/api/mcp"
    }
  }
}
```

## Self-host

The server is a single stateless Node file (fresh `McpServer` per request, plain JSON responses,
binds to `127.0.0.1` — put it behind your reverse proxy). It reads one dataset file and hot-reloads
it on mtime change.

```sh
npm install
curl -O https://sunshineatlas.com/data/sunshine-atlas-destinations.json
PORT=8787 DATA_FILE=./sunshine-atlas-destinations.json node server.mjs
```

`GET /healthz` reports status and destination count. `server.json` is the MCP-registry manifest.

## Data & methodology

- Sunshine Score = `100 × warmth × (0.5 + 0.5 × (0.55 × dryness + 0.45 × sunniness))`, computed
  from long-term climate normals — [methodology](https://sunshineatlas.com/methodology/).
- Sources: CRU climatology; places from GeoNames & OurAirports; sea temperatures via Open-Meteo.
- Dataset: [sunshineatlas.com/data](https://sunshineatlas.com/data/) · CSV/JSON · CC BY 4.0 ·
  mirrors on [GitHub](https://github.com/Flightmussy/sunshine-atlas-data),
  [Hugging Face](https://huggingface.co/datasets/Flightmussy/sunshine-atlas),
  [Kaggle](https://www.kaggle.com/datasets/albanius/sunshine-scores-and-climate-for-3833-destinations).

## License

Code MIT. Data CC BY 4.0 (credit "Sunshine Atlas" + link). Not a forecast — climate normals
describe typical conditions, not this week's weather.
