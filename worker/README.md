# Worker

Backend do SIGAA Caiu — Cloudflare Worker com Cron Triggers e banco D1 (SQLite).

## Estrutura

```
src/
  index.ts    ← entry point (scheduled + fetch handlers)
  health.ts   ← health check do SIGAA (fetch + logica de status)
  db.ts       ← operacoes no D1 (salvar, consultar, incidentes)
  api.ts      ← rotas da API (/api/status, /history, /stats, /incidents)
  cache.ts    ← cache de leitura da API publica (TTL por rota)
  cors.ts     ← headers CORS
  types.ts    ← interfaces TypeScript
scripts/
  cache-stats.mjs  ← taxa de acerto do cache a partir do trafego real
schema.sql    ← schema do banco D1
```

## Dev local

```bash
npm install

# Criar banco local
npx wrangler d1 execute sigaa-caiu-unb-db --local --file=schema.sql

# Rodar
npx wrangler dev --port 8787 --test-scheduled

# Simular um health check (cron)
curl "http://localhost:8787/__scheduled?cron=*/3+*+*+*+*"

# Testar endpoints
curl http://localhost:8787/api/status
curl http://localhost:8787/api/history?period=24h
curl http://localhost:8787/api/stats
curl http://localhost:8787/api/incidents
```

## Setup inicial (primeira vez)

```bash
# Login no Cloudflare
npx wrangler login

# Criar banco D1
npx wrangler d1 create sigaa-caiu-unb-db
# Copiar o database_id retornado pro wrangler.jsonc

# Aplicar schema no banco remoto
npx wrangler d1 execute sigaa-caiu-unb-db --remote --file=schema.sql

# Indices parciais que removem full table scans (ver secao Cache)
npx wrangler d1 execute sigaa-caiu-unb-db --remote --file=schema_migration_cache_indexes.sql

# Indice de janela temporal em other_service_checks
npx wrangler d1 execute sigaa-caiu-unb-db --remote --file=schema_migration_timestamp_index.sql
```

### Conferir se o banco bate com o schema

As migracoes acima sao aplicadas na mao, e nada avisa quando alguem esquece. Ja
aconteceu: os indices parciais ficaram commitados no repo por semanas enquanto o banco
rodava sem eles, e o unico sintoma era uma consulta lendo a tabela inteira a cada
request. O verificador compara `schema.sql` com o `sqlite_master` do banco e sai com
codigo 1 se divergir.

```bash
npm run db:verify         # banco remoto
npm run db:verify:local   # banco local do `wrangler dev`
```

Compara definicao, nao so nome: um indice que existe com o nome certo mas nas colunas
erradas tambem e apontado. O deploy roda isso antes do `wrangler deploy`, entao um
banco desatualizado quebra o build em vez de passar despercebido.

Quando falhar por objeto faltando, `npm run db:remote` resolve -- o `schema.sql` e todo
`IF NOT EXISTS` e pode ser reexecutado. Coluna nova e outra historia: `CREATE TABLE` nao
altera tabela existente, entao essas continuam vindo dos `schema_migration_*.sql`.

## Deploy

```bash
npx wrangler deploy
```

## Schema D1

```sql
checks (id, timestamp, status, http_code, response_time_ms, error)
incidents (id, started_at, ended_at, duration_s)
```

Dados sao mantidos por 2 anos. Cleanup automatico roda diariamente via cron.

## Cache

A API publica e lida muito mais do que escrita: o cron grava a cada 3 minutos, mas
cada visitante com a aba aberta consulta os mesmos endpoints em loop. O cache existe
para que essas leituras repetidas nao virem `rows read` no D1 -- o limite do free tier
e de 5.000.000/dia e e compartilhado por toda a conta Cloudflare.

### Onde o cache fica, e onde nao fica

`cache.ts` envolve apenas o handler `fetch`. **O cron nunca le do cache.** Isso nao e
convencao, e estrutural: `scheduled()` chama `db.ts` direto e nunca passa por
`withEdgeCache`. Importa porque `getLastNChecks` e `getOpenIncident` decidem quando
abrir e fechar um incidente -- dado velho ali abre incidente fantasma e dispara
notificacao falsa no Telegram.

### Tres camadas

| Camada | Escopo | Observacao |
|---|---|---|
| memoria do isolate | um isolate | funciona sempre; some quando o isolate recicla |
| `caches.default` | um colo | compartilhado entre isolates; sujeito a evicao |
| `Cache-Control` | navegador | o mais barato: nem chega na Cloudflare |

### TTL por rota

| Rota | borda | navegador | Por que |
|---|---|---|---|
| `/api/status` | 60s | 30s | cron escreve a cada 180s |
| `/api/other-services` | 60s | 30s | idem |
| `/api/incidents` | 300s | 120s | incidentes mudam em dias |
| `/api/stats` | 600s | 300s | uptime de 24h+ mal se move |
| `/api/history?period=24h` | 180s | 90s | casa 1:1 com a escrita |
| `/api/history?period=7d` | 900s | 300s | = tamanho do bucket (15 min) |
| `/api/history?period=30d` | 1800s | 600s | metade do bucket (60 min) |
| `/api/history?period=90d` | 3600s | 900s | 1/3 do bucket (180 min) |
| `/` (docs) | 86400s | 3600s | string constante no bundle |

Rotas fora dessa lista **nao sao cacheadas**: `routeFor()` e whitelist, entao rota nova
nasce sem cache e cachear e um ato deliberado. Respostas 4xx/5xx nunca entram no cache.
Query params desconhecidos sao descartados na chave, senao um link com
`?utm_source=...` criaria chaves infinitas, cada uma uma query nova no D1.

### Invalidacao

Tudo por TTL, nada por evento. `caches.default.delete()` chamado no cron limparia
apenas o colo onde aquele cron rodou -- os outros continuariam servindo o valor antigo
ate o TTL expirar de qualquer forma. Como a escrita e previsivel (a cada 180s, sempre
pelo cron), TTL alinhado a cadencia e exato, nao aproximado.

Para invalidar tudo de uma vez, suba `CACHE_VERSION` em `cache.ts` e faca deploy.

### Como medir

Toda resposta cacheavel traz `X-Cache: HIT-isolate | HIT-edge | MISS`:

```bash
curl -sI https://SEU-WORKER/api/stats | grep -i x-cache
```

`HIT-isolate` costuma dominar, porque a camada 1 responde antes de consultar a borda;
`HIT-edge` aparece quando o isolate reciclou ou quando outro isolate do mesmo colo ja
tinha a entrada.

Para a taxa de acerto no trafego real, agregando os logs estruturados:

```bash
npm run cache:stats          # ao vivo, via `wrangler tail`; Ctrl-C mostra o resumo

# ou, a partir de um dump salvo:
npx wrangler tail --format json > tail.log
node scripts/cache-stats.mjs --stdin < tail.log
```

### Dominio proprio

Nao e necessario para o cache: `caches.default` foi verificado funcionando na URL
`*.workers.dev`, servindo `X-Cache: HIT-edge`. Um dominio proprio continua util por
outros motivos (URL estavel, independente do subdominio da conta), e nesse caso basta:

```jsonc
// wrangler.jsonc
"routes": [{ "pattern": "api-XX.sigaacaiu.com", "custom_domain": true }]
```

e apontar `NEXT_PUBLIC_API_URL` do frontend pra ele. E aditivo: a URL `workers.dev`
continua funcionando em paralelo.
