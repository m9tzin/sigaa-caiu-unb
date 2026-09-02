# Rollup de agregados no D1

**Data:** 2026-09-02
**Aplica-se a:** `sigaa-caiu-ufg` e `sigaa-caiu-unb` (mesma conta Cloudflare,
`add57c7093b25ef9ae443c414d12c81c`)

## Problema

As leituras de linha do D1 passaram do teto de 5M/dia do free tier. O limite é
**por conta, não por banco**, e os dois workers dividem o mesmo orçamento.

O trabalho de `perf/d1-rows-read` (PR #9) e `13bc2db` está publicado nos dois e os
índices estão aplicados nos dois bancos (`db:verify` volta `tudo em dia`). O deploy
não é o problema. O que aquele trabalho cortou foi **round trips e latência** —
`getStats` passou de 8 idas ao D1 para um `batch()`, de ~1,2s para ~24ms. Cada
statement continua varrendo a janela crua inteira, então as linhas lidas não
mudaram.

Cruzando os TTLs de `src/cache.ts` com os `ROWS_PER_MISS` medidos em
`scripts/cache-stats.mjs` (`b1094e6`), o piso diário com cache perfeito, por colo:

| | UFG | UnB | Conta |
|---|---|---|---|
| linhas lidas/dia | 17.264.712 | 14.201.136 | **31.465.848** = 6,3x o teto |

`/api/stats` responde por metade disso sozinho: 144 misses/dia x 60.750 linhas =
8,7M. Os 60.750 conferem com 480 checks/dia x (90+30+7+1) dias — a rota varre a
janela crua de cada um dos quatro períodos.

## Objetivo

Levar a conta para baixo de 5M/dia com folga suficiente para mais de um colo,
sem mudar o que os gráficos mostram.

**Resultado projetado:** 2.361.216 linhas/dia (47% do teto, folga de 2,1x),
redução de 92,5%.

## Decisões tomadas

1. **Tolerância de imprecisão: borda de 1 dia.** `/api/stats` passa a agregar
   buckets diários para 7d/30d/90d. A janela de 90d vira "os últimos 90 dias
   completos + o dia corrente". O uptime varia no arredondamento das horas da
   ponta. O 24h continua com resolução fina.
2. **Escrita incremental (UPSERT no tick) + auto-cura diária**, em vez de
   recomputar a cada tick. O `db.batch()` do D1 é atômico, então o check e sua
   contribuição no rollup aterrissam juntos; a deriva só pode vir de fora do cron,
   e é isso que a cura diária cobre.
3. **Sem vitest.** O risco está na semântica de SQL contra dados reais, não em
   lógica de JS. A verificação é um script de paridade contra o banco de produção
   (ver "Testes").
4. **Sem arquivo de migração.** São tabelas novas; `schema.sql` é idempotente e
   `npm run db:remote` as aplica. Os `schema_migration_*.sql` existem para o que
   `CREATE TABLE` não faz (colunas novas), conforme o epílogo de `db-verify.mjs`.

## Schema

Duas tabelas, com a granularidade na chave primária. Regra que governa tudo:
**guardar soma e contagem, nunca média** — médias não compõem, então um bucket de
60 min derivado de quatro de 15 tem de ser `SUM(sum)/SUM(n)`.

```sql
CREATE TABLE IF NOT EXISTS check_rollup (
  granularity         TEXT    NOT NULL CHECK (granularity IN ('15m','1h','1d')),
  bucket_start        TEXT    NOT NULL,  -- ISO '%Y-%m-%dT%H:%M:%SZ' em TODAS as
                                          -- granularidades; '1d' alinha em T00:00:00Z
  n                   INTEGER NOT NULL DEFAULT 0,
  n_offline           INTEGER NOT NULL DEFAULT 0,
  n_degraded          INTEGER NOT NULL DEFAULT 0,
  sum_response_ms     INTEGER NOT NULL DEFAULT 0,
  n_response          INTEGER NOT NULL DEFAULT 0,
  sum_reachability_ms INTEGER NOT NULL DEFAULT 0, n_reachability INTEGER NOT NULL DEFAULT 0,
  sum_portal_ms       INTEGER NOT NULL DEFAULT 0, n_portal       INTEGER NOT NULL DEFAULT 0,
  sum_login_form_ms   INTEGER NOT NULL DEFAULT 0, n_login_form   INTEGER NOT NULL DEFAULT 0,
  sum_login_e2e_ms    INTEGER NOT NULL DEFAULT 0, n_login_e2e    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (granularity, bucket_start)
);

CREATE TABLE IF NOT EXISTS other_service_rollup (
  granularity     TEXT    NOT NULL CHECK (granularity IN ('15m','1h')),
  bucket_start    TEXT    NOT NULL,
  service_id      TEXT    NOT NULL,
  n               INTEGER NOT NULL DEFAULT 0,
  sum_response_ms INTEGER NOT NULL DEFAULT 0,
  n_response      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (granularity, bucket_start, service_id)
);
```

Sem índices secundários: com a granularidade liderando a PK, cada leitura é um
range contíguo já ordenado.

**Uma contagem por camada.** As colunas `*_ms` de `checks` são nullable porque nem
toda camada roda em todo tick, e `AVG()` ignora NULL. Dividir pelo `n` global
diluiria a média em direção a zero justamente nas camadas que rodam menos.

**Linhas `'1d'` carregam colunas de camada sem usar.** São ~400 linhas com alguns
inteiros a mais — o preço de não ter uma terceira tabela para manter, migrar e curar.

**`n_degraded` só serve a history** (o "pior status do bucket"); `/api/stats` usa
`n - n_offline`, porque `getStats` hoje conta `status != 'offline'`, tratando
`degraded` como no ar.

**Incidents fica de fora.** A contagem já usa `idx_incidents_started` e contribui
com ~0 do custo medido. Não vale uma tabela.

Tamanho: `check_rollup` ~11.200 linhas (8.640 de 15m + 2.160 de 1h + 400 diárias);
`other_service_rollup` 8.640 x nº de serviços por granularidade fina.

## Escrita

### O relógio

`saveCheck` hoje não passa timestamp — deixa o `DEFAULT (strftime(...,'now'))` da
coluna resolver. Se o upsert do bucket chamasse `'now'` de novo seriam duas
leituras de relógio no mesmo batch, e num limite de 15 minutos elas caem em
buckets diferentes.

**Regra:** o timestamp é calculado uma vez em JS e vinculado aos statements do
batch; o `bucket_start` é derivado **em SQL** a partir dele, com a mesma expressão
que `getHistory` já usa no `GROUP BY`:

```sql
strftime('%Y-%m-%dT%H:', ?1) || printf('%02d:00Z', (CAST(strftime('%M', ?1) AS INTEGER) / 15) * 15)
```

Um relógio só (JS, vinculado), uma fórmula de bucket só (SQL). Se a fórmula
vivesse em JS na escrita e em SQL no recompute, elas divergiriam num detalhe de
formatação e o `ON CONFLICT` deixaria de casar — criando linhas duplicadas em vez
de somar, em silêncio. Mesma família do bug corrigido em `083ec9e`.

D1 aceita parâmetros numerados (`?1`); se der problema, vincular o timestamp
mais de uma vez.

### O upsert

`saveCheck` passa a emitir, num único `db.batch()`: o `INSERT INTO checks` de
sempre mais três upserts em `check_rollup` (`'15m'`, `'1h'`, `'1d'`).
`saveOtherServiceChecks` ganha o mesmo tratamento com duas granularidades por
serviço.

```sql
INSERT INTO check_rollup (granularity, bucket_start, n, n_offline, n_degraded,
                          sum_response_ms, n_response, sum_portal_ms, n_portal, ...)
VALUES (
  '15m',
  strftime('%Y-%m-%dT%H:', ?1) || printf('%02d:00Z', (CAST(strftime('%M', ?1) AS INTEGER) / 15) * 15),
  1,
  CASE WHEN ?2 = 'offline'  THEN 1 ELSE 0 END,
  CASE WHEN ?2 = 'degraded' THEN 1 ELSE 0 END,
  COALESCE(?3, 0), CASE WHEN ?3 IS NULL THEN 0 ELSE 1 END,
  COALESCE(?4, 0), CASE WHEN ?4 IS NULL THEN 0 ELSE 1 END,
  ...
)
ON CONFLICT(granularity, bucket_start) DO UPDATE SET
  n               = n + 1,
  n_offline       = n_offline       + excluded.n_offline,
  n_degraded      = n_degraded      + excluded.n_degraded,
  sum_response_ms = sum_response_ms + excluded.sum_response_ms,
  n_response      = n_response      + excluded.n_response,
  sum_portal_ms   = sum_portal_ms   + excluded.sum_portal_ms,
  n_portal        = n_portal        + excluded.n_portal,
  ...;
```

`excluded.` evita repetir os `CASE` na cláusula de update. O par
`COALESCE(?, 0)` / `CASE WHEN ? IS NULL` é o que faz a contagem por camada andar
só quando a camada rodou — é ele que preserva a semântica de `AVG()` ignorando NULL.

Para `'1h'` e `'1d'` muda só o literal de granularidade e a expressão de
alinhamento (`...||printf('%02d:00:00Z', hora)` para `'1h'`, e `date(?1)||'T00:00:00Z'` para `'1d'`).

### Auto-cura e bootstrap

Uma função só, `recomputeRollup(db, since)`, com semântica de **substituição**:

```sql
INSERT INTO check_rollup (granularity, bucket_start, n, n_offline, ...)
SELECT '15m',
       strftime('%Y-%m-%dT%H:', timestamp) ||
         printf('%02d:00Z', (CAST(strftime('%M', timestamp) AS INTEGER) / 15) * 15),
       COUNT(*),
       SUM(CASE WHEN status = 'offline' THEN 1 ELSE 0 END),
       ...
FROM checks
WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?1)
GROUP BY 2
ON CONFLICT(granularity, bucket_start) DO UPDATE SET
  n = excluded.n, n_offline = excluded.n_offline, ...;
```

A diferença para o caminho incremental é `= excluded.x` (substitui) em vez de
`= x + excluded.x` (soma). É isso que torna o recompute idempotente e
re-executável, e que impede contagem dobrada quando ele roda com o worker já
publicado.

No `scheduled()`:

```ts
const empty = await db.prepare("SELECT 1 FROM check_rollup LIMIT 1").first();
if (empty === null) {
  ctx.waitUntil(recomputeRollup(env.DB, null));        // bootstrap: histórico inteiro
} else if (now.getUTCHours() === 3 && minute < 5) {
  ctx.waitUntil(recomputeRollup(env.DB, "-2 days"));   // auto-cura diária
}
```

O bootstrap dispensa passo manual de backfill: o primeiro tick depois do deploy
detecta o rollup vazio e reconstrói tudo. Backfill e cura são o mesmo código, então
o backfill é exercitado em produção todo dia. A janela de 2 dias cobre com folga
qualquer virada de dia UTC.

**Risco assumido:** o bootstrap varre `checks` inteira (~350k linhas nos 730 dias de
retenção) dentro de um `waitUntil`. Se estourar o limite de CPU do cron, o rollup
fica parcial; como o recompute substitui, é seguro rodar de novo ou executar o mesmo
SQL por fora com `wrangler d1 execute --remote`. Conferir o primeiro tick, não assumir.

O `SELECT 1 ... LIMIT 1` custa 1 linha por tick (480/dia).

### Retenção

`cleanupOldChecks` ganha, com margem sobre o que as rotas leem:

```sql
DELETE FROM check_rollup
  WHERE granularity IN ('15m','1h') AND bucket_start < strftime('%Y-%m-%dT%H:%M:%SZ','now','-100 days');
DELETE FROM check_rollup
  WHERE granularity = '1d' AND bucket_start < strftime('%Y-%m-%dT%H:%M:%SZ','now','-400 days');
DELETE FROM other_service_rollup
  WHERE bucket_start < strftime('%Y-%m-%dT%H:%M:%SZ','now','-40 days');
```

### Custo da escrita

Upserts são point lookups na PK: 3 por check mais 2 por serviço, e o `SELECT 1` do
bootstrap. Com 480 ticks/dia dá ~5.800 linhas/dia na UFG (4 serviços).

A cura diária varre a janela de 2 dias uma vez por granularidade: 3 x 960 linhas de
`checks` mais 2 x 3.840 de `other_service_checks` = ~10.600 linhas, uma vez por dia.

**Total abaixo de 17k linhas/dia por repo** — 0,3% do teto.

**Efeito preservado, não corrigido:** durante um incidente o cron roda a cada
minuto, então aqueles buckets recebem 3x mais amostras e pesam mais no uptime.
`getStats` já se comporta assim contando linhas cruas; o rollup reproduz o viés
existente em vez de introduzir um novo.

## Leitura

| Rota | Fonte | Linhas lidas | Antes (UFG) |
|---|---|---|---|
| `/api/status` | `checks` indexado | 10 | 10 |
| `/api/stats` | `'1d'` (90) + `'1h'` (24) + incidents | ~125 | 60.750 |
| `/api/history/24h` | `checks` cru | 356 | 356 |
| `/api/history/7d` | `'15m'` | 672 | 7.137 |
| `/api/history/30d` | `'1h'` | 720 | 29.194 |
| `/api/history/90d` | `'1h'` agrupado 3:1 | 2.160 | 87.879 |
| `/api/other-services/history/24h` | cru | 1.424 | 1.424 |
| `/api/other-services/history/7d` | `'15m'` | 2.688 | 12.976 |
| `/api/other-services/history/30d` | `'1h'` | 2.880 | 45.792 |

As rotas de 24h não mudam: devolvem pontos de 3 minutos, que é a própria cadência
do cron. Não há downsample a fazer ali.

### `/api/stats` em três statements

Os quatro períodos saem de uma varredura só, com agregação condicional:

```sql
SELECT
  SUM(CASE WHEN bucket_start >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-7 days')  THEN n         ELSE 0 END) AS n_7d,
  SUM(CASE WHEN bucket_start >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-7 days')  THEN n_offline ELSE 0 END) AS off_7d,
  SUM(CASE WHEN bucket_start >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-30 days') THEN n         ELSE 0 END) AS n_30d,
  ...
FROM check_rollup
WHERE granularity = '1d'
  AND bucket_start >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-90 days');
```

90 linhas servem 7d, 30d e 90d. O 24h vira `granularity = '1h'` nas últimas 24
linhas. Os quatro `COUNT(*)` de incidents viram um só pelo mesmo truque. O endpoint
sai de 8 statements e 60.750 linhas para 3 statements e ~125 linhas.

### `/api/history` reconstruído

Mesma estrutura de hoje, trocando `AVG(x)` por `SUM(sum_x)/SUM(n_x)`:

```sql
SELECT
  CAST(strftime('%s', MIN(bucket_start)) AS INTEGER) AS id,
  MIN(bucket_start) AS timestamp,
  CASE WHEN SUM(n_offline)  > 0 THEN 'offline'
       WHEN SUM(n_degraded) > 0 THEN 'degraded'
       ELSE 'online' END AS status,
  NULL AS http_code,
  CASE WHEN SUM(n_response) = 0 THEN NULL
       ELSE ROUND(CAST(SUM(sum_response_ms) AS REAL) / SUM(n_response)) END AS response_time_ms,
  NULL AS error,
  CASE WHEN SUM(n_portal) = 0 THEN NULL
       ELSE ROUND(CAST(SUM(sum_portal_ms) AS REAL) / SUM(n_portal)) END AS portal_ms,
  ...
FROM check_rollup
WHERE granularity = '1h'
  AND bucket_start >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-90 days')
GROUP BY strftime('%Y-%m-%dT', bucket_start) ||
         printf('%02d:00:00Z', (CAST(strftime('%H', bucket_start) AS INTEGER) / 3) * 3)
ORDER BY timestamp ASC;
```

O `CASE WHEN SUM(n_x) = 0 THEN NULL` é obrigatório: é o caminho em que `AVG()`
devolveria NULL hoje. Sem ele, uma camada ausente em todo o grupo vira uma linha de
0ms no `LayerResponseChart` em vez de um buraco.

Para 7d e 30d o `GROUP BY` some — a granularidade já é a certa.

**Mudanças visíveis na resposta da API**, ambas em campos que nenhum componente
renderiza:

- `http_code` passa a ser `NULL` no caminho bucketizado. Hoje é
  `ROUND(AVG(http_code))` — a média entre um 200 e um 500 é 350, um número sem
  significado. Está em `web/src/lib/types.ts` mas nenhum componente lê.
- `id` passa a ser `CAST(strftime('%s', bucket_start) AS INTEGER)`. Hoje é o `id`
  arbitrário de uma linha do grupo. Os gráficos usam o índice do array como `key`
  (`ResponseTimeChart.tsx:52`, `LayerResponseChart.tsx:67`), não o `id`.

### Resultado

| | UFG | UnB | Conta |
|---|---|---|---|
| hoje | 17.264.712 | 14.201.136 | 31.465.848 (6,3x o teto) |
| depois | 1.453.440 | 907.776 | **2.361.216** (47% do teto) |

Redução de 92,5%, folga de 2,1x.

O resíduo é dominado por `other-services/history/24h` (43%) e `history/24h` (15%) —
as duas rotas cruas, 480 misses/dia cada com TTL de 180s. **Lever de reserva, fora
do escopo desta spec:** subir esses dois TTLs para 300s leva a conta a ~1,82M (36%
do teto, 2,7x de folga), ao custo de o gráfico de 24h ficar até 5 minutos velho em
vez de 3. Reversível em uma linha; não é necessário para caber.

## Rollout

Ordem não negociável: **banco antes do código**. Se o worker subir antes das
tabelas existirem, todo tick de cron lança exceção no upsert.

1. Adicionar os dois `CREATE TABLE` a `schema.sql` nos dois repos.
2. `npm run db:remote` em cada repo.
3. `npm run db:verify` nos dois — tem de voltar `tudo em dia`.
4. Deploy. **UnB:** push para `main`, o CI publica. **UFG:** `npm run deploy` a
   partir de `worker/`, à mão — o repo é fork de `trindadetiago/sigaa-caiu` e suas
   Actions nunca executam (um run enfileirado desde 2026-08-14).
5. Conferir o primeiro tick de cada worker e rodar o script de paridade.

O passo 2 antes do 4 tem guarda-costas na UnB: o `db:verify` do workflow falha o
deploy se o banco divergir de `schema.sql`. Na UFG esse guarda não roda; lá a ordem
é responsabilidade de quem publica.

## Testes

Sem runner novo. O risco é semântica de SQL contra a distribuição de dados real —
camadas nulas em faixas longas, buracos de cron, rajadas de amostra durante
incidente, bordas de bucket. Fixtures sintéticas modelam isso mal.

A propriedade que torna a verificação melhor que testes unitários: **os dados crus
continuam lá**. Dá para rodar a query velha e a nova lado a lado no banco de
produção e exigir que concordem.

**`scripts/rollup-parity.mjs`**, no idioma dos scripts existentes (`.mjs` puro
dirigindo `wrangler d1 execute --json`, sem dependência nova):

- Roda a query antiga e a nova de cada rota contra o banco remoto.
- Compara série contra série e falha com diff quando divergem. Tolerância: borda de
  1 dia no `/api/stats`; **zero** em 7d/30d/90d de history, que têm de bater exato.
- Reporta `meta.rows_read` dos dois lados — o mesmo mecanismo que produziu os
  `ROWS_PER_MISS` de `b1094e6`. Transforma "cortamos 92,5%" de projeção em medição e
  já deixa os valores prontos para atualizar `cache-stats.mjs`.

Três casos obrigatórios, porque são onde o design falha em silêncio:

1. **Camada ausente num grupo inteiro** — tem de sair `null`, não `0`.
2. **Composição de média** — um bucket de 60 min derivado de quatro de 15 tem de
   bater com o `AVG` cru. Prova que soma/contagem estava certo e média teria errado.
3. **Idempotência do recompute** — rodar `recomputeRollup` duas vezes não pode mudar
   número nenhum. Prova que a semântica de substituição está no lugar da de soma.

## Pendências após a implementação

- Atualizar `ROWS_PER_MISS` em `scripts/cache-stats.mjs` **nos dois repos**, com os
  valores medidos por `rollup-parity.mjs`. Os números diferem por banco: tamanho e
  número de serviços não coincidem.
- Atualizar `worker/README.md` com a existência do rollup e a regra soma/contagem.
