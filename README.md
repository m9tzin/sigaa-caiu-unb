# SIGAA Caiu? — UnB

Monitor em tempo real do [SIGAA da UnB](https://sigaa.unb.br). Verifica automaticamente se o sistema esta no ar, lento ou fora do ar a cada 3 minutos.

**Site:** [unb.sigaacaiu.com](https://unb.sigaacaiu.com)

## Como funciona

Um [Cloudflare Worker](https://workers.cloudflare.com/) faz requisicoes periodicas ao SIGAA UnB e salva o resultado num banco de dados D1. O frontend consome esses dados e exibe o status atual, historico e incidentes.

```
Cloudflare Worker (cron a cada 3 min)
  │
  ├── Layer 1: GET sigaa.unb.br/sigaa/verTelaLogin.do
  │   └── 200/302 = servidor vivo
  │
  ├── Layer 2: conteudo da pagina de login
  │   └── verifica se a pagina carrega com conteudo esperado
  │
  ├── Layer 3: campos do formulario de autenticacao
  │   └── verifica campos user.login e user.senha
  │
  └── Salva no D1 (SQLite)

Frontend (Next.js no Vercel)
  └── Consome a API publica do Worker
```

> **Nota:** A UnB usa autenticacao propria no SIGAA (sem SSO/CAS separado). O check E2E de login (camada 4) esta disponivel mas requer credenciais configuradas via secret.

## API Publica

Base URL: `https://sigaa-caiu-unb-worker.matheusmrno.workers.dev`

A API e aberta — qualquer pessoa pode consumir, sem autenticacao.

### `GET /api/status`

Status atual do SIGAA UnB.

```json
{
  "status": "online",
  "confirmed": true,
  "lastCheck": {
    "timestamp": "2026-06-19T12:00:00Z",
    "status": "online",
    "httpCode": 200,
    "responseTimeMs": 850
  },
  "consecutiveFailures": 0,
  "currentIncident": null
}
```

| Campo                 | Descricao                                               |
| --------------------- | ------------------------------------------------------- |
| `status`              | `online`, `degraded` ou `offline`                       |
| `confirmed`           | `false` se houve apenas 1 falha (possivel flap de rede) |
| `consecutiveFailures` | Quantas falhas consecutivas ate agora                   |
| `currentIncident`     | Incidente em andamento, se houver                       |

### `GET /api/history?period=24h|7d|30d`

Historico de checks. Para `7d` e `30d` os dados sao agregados (downsampled).

### `GET /api/stats`

Uptime e tempo medio de resposta por periodo.

### `GET /api/incidents`

Ultimos 10 incidentes (periodos de indisponibilidade).

## Estrutura

```
sigaa-caiu-unb/
├── worker/    ← Cloudflare Worker (API + cron + D1)
├── web/       ← Next.js (frontend no Vercel)
└── README.md
```

## Universidades

Instancias do projeto rodando por ai:

| Universidade | Site                                           |
| ------------ | ---------------------------------------------- |
| **UFPB**     | [sigaacaiu.com](https://sigaacaiu.com)         |
| **UFG**      | [ufg.sigaacaiu.com](https://ufg.sigaacaiu.com) |
| **UNB**      | [unb.sigaacaiu.com](https://unb.sigaacaiu.com) |

## Issues e sugestoes

Abra uma [issue](https://github.com/m9tzin/sigaa-caiu-unb/issues) se encontrar um bug ou tiver uma sugestao.

## Licenca e creditos

Este projeto e open source sob a licenca [MIT](LICENSE) — voce pode usar, modificar e fazer fork livremente.

Baseado no projeto original [sigaacaiu.com](https://sigaacaiu.com) por [trindadetiago](https://github.com/trindadetiago/sigaa-caiu).
