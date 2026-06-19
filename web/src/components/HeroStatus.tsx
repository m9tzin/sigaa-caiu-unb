"use client";

import { useMemo } from "react";
import type { StatusResponse, Incident } from "@/lib/types";
import { formatMs, timeAgo } from "@/lib/utils";
import { useTheme } from "@/lib/ThemeContext";

interface Props {
  data: StatusResponse | null;
  error: boolean;
  daysSinceLastIncident: number | null;
  incidents: Incident[] | null;
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// prettier-ignore
const ONLINE_RESPONSES = [
  { emoji: "👍",    text: "Nao!",             sub: "Milagrosamente funcionando." },
  { emoji: "👍",    text: "Nao, ta no ar!",   sub: "Aproveita enquanto dura." },
  { emoji: "🎉",    text: "Nao!",             sub: "Inacreditavel, mas ta funcionando." },
  { emoji: "👍",    text: "Nao, pode ir!",    sub: "Corre antes que caia." },
  { emoji: "🙏",    text: "Nao!",             sub: "Gracas a Deus e ao STI." },
  { emoji: "👍",    text: "Nao!",             sub: "Nao, voce nao ta sonhando." },
  /* World Cup */
  { emoji: "🇧🇷⚽", text: "Nao, ta firme!",        sub: "Aguentou o gol, o VAR e a revisao." },
  { emoji: "🏆🇧🇷", text: "Nao, ta de pe!",         sub: "Sobreviveu ate a prorrogacao." },
  { emoji: "⚽✅",   text: "Nao, fez o gol!",        sub: "Chutou no angulo e foi. GOLACO!"},
  { emoji: "🇧🇷🏃", text: "Nao, driblou tudo!",     sub: "Passou por cima da instabilidade e ta no ar." },
  { emoji: "🏟️🇧🇷", text: "Nao, escalado hoje!",    sub: "Saiu como titular e ta rendendo." },
  { emoji: "🇧🇷🎺", text: "Nao!",                   sub: "Nem a vuvuzela desafinou o servidor hoje." },
  { emoji: "🥅🇧🇷", text: "Nao, defendeu!",          sub: "Nem o ataque do dia de prova derrubou." },
  { emoji: "📺🇧🇷", text: "Nao, ta no ar!",          sub: "Jogo comecando, SIGAA funcionando. Dia perfeito." },
];

// prettier-ignore
const SLOW_RESPONSES = [
  { emoji: "🐌",  text: "Ainda nao, mas...",    sub: "Ta taaao lento que ja ja cai..." },
  { emoji: "😮‍💨", text: "Nao, mas quase",       sub: "Ta mais lento que fila do RU." },
  { emoji: "🐢",  text: "Mais ou menos",         sub: "Ta funcionando em camera lenta." },
  { emoji: "⏳",  text: "Nao... ainda",          sub: "Pega um cafe enquanto carrega." },
  { emoji: "🦥",  text: "Nao, mas ta arrastando",sub: "Mais lento que matricula em periodo." },
  /* World Cup */
  { emoji: "🇧🇷", text: "Nao, mas ta na torcida",sub: "Um olho no jogo, outro no sistema." },
  { emoji: "⏱🇧🇷", text: "Lento, igual VAR",     sub: "Ta analisando o lance ha 10 minutos." },
];

// prettier-ignore
const DOWN_RESPONSES = [
  { emoji: "👎",    text: "Sim, caiu",         sub: "F no chat. Vai tomar um cafe e volta depois." },
  { emoji: "💀",    text: "Sim, morreu",        sub: "Descanse em paz, SIGAA." },
  { emoji: "👎",    text: "Sim",                sub: "Surpresa de ninguem." },
  { emoji: "😭",    text: "Sim...",             sub: "Era previsivel, ne?" },
  { emoji: "🪦",    text: "Sim, foi de base",   sub: "Causa da morte: ser o SIGAA." },
  { emoji: "📚",    text: "Caiu!",              sub: "Deve estar fazendo prova." },
  /* World Cup */
  { emoji: "🇧🇷",   text: "Sim, foi ver o jogo!", sub: "O SIGAA foi assistir o Brasil jogar. Volta depois do apito final." },
  { emoji: "🎊🇧🇷", text: "Caiu de emocao!",    sub: "Nao segurou o gol e foi junto. Volta quando se recuperar." },
];

// prettier-ignore
const CHECKING_RESPONSES = [
  { emoji: "🤔", text: "Hmm...",            sub: "Parece que oscilou. Verificando se caiu mesmo..." },
  { emoji: "👀", text: "Calma ai...",        sub: "To olhando, parece que deu uma tremida." },
  { emoji: "🔍", text: "Investigando...",    sub: "Pode ter sido so um soluço." },
  { emoji: "🧐", text: "Curioso...",         sub: "Agora ha pouco eu estava no reCAPTCHA." },
  { emoji: "😅", text: "Espera um pouco...", sub: "Ele pode estar preparando uma pegadinha." },
];

// prettier-ignore
const RECOVERING_RESPONSES = [
  { emoji: "🤞",  text: "Parece que voltou", sub: "Mas nao confia nao, caiu agora pouco." },
  { emoji: "👀",  text: "Voltou... sera?",   sub: "Ainda ta quente, fica de olho." },
  { emoji: "😅",  text: "Voltou, mas...",    sub: "Acabou de cair. Nao bota muita fe nao." },
  { emoji: "⚠️",  text: "Ta no ar de novo",  sub: "Caiu faz pouco, pode oscilar ainda." },
  { emoji: "👻",  text: "Surpresa!",         sub: "Era so pra passar um susto rsrs." },
];

const STATUS_COLORS = {
  online: "#22c55e",
  degraded: "#eab308",
  offline: "#ef4444",
  muted: "#666666",
};

export function HeroStatus({
  data,
  error,
  daysSinceLastIncident,
  incidents,
}: Props) {
  const { theme } = useTheme();

  const recentlyRecovered = useMemo(() => {
    if (!incidents || incidents.length === 0) return false;
    const lastIncident = incidents[0];
    if (!lastIncident.ended_at) return false;
    const endedAgo = Date.now() - new Date(lastIncident.ended_at).getTime();
    return endedAgo < 10 * 60 * 1000;
  }, [incidents]);

  const response = useMemo(() => {
    if (error) return null;
    if (!data || !data.lastCheck) return null;

    const isDown = data.status === "offline" && data.confirmed;
    const isSlow = data.status === "degraded";
    const isChecking = data.status === "offline" && !data.confirmed;

    if (isDown) return pickRandom(DOWN_RESPONSES);
    if (isSlow) return pickRandom(SLOW_RESPONSES);
    if (isChecking) return pickRandom(CHECKING_RESPONSES);
    if (recentlyRecovered) return pickRandom(RECOVERING_RESPONSES);
    return pickRandom(ONLINE_RESPONSES);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.status, data?.confirmed, error, recentlyRecovered]);

  const statusColor =
    data?.status === "offline"
      ? "text-red-500"
      : data?.status === "degraded" || recentlyRecovered
        ? "text-yellow-500"
        : "text-green-500";

  const institutionalStatus = useMemo(() => {
    if (error)
      return { label: "ERRO DE COMUNICAÇÃO", color: STATUS_COLORS.offline };
    if (!data || !data.lastCheck)
      return { label: "AGUARDANDO DADOS...", color: STATUS_COLORS.muted };

    const isDown = data.status === "offline" && data.confirmed;
    const isSlow = data.status === "degraded";
    const isChecking = data.status === "offline" && !data.confirmed;

    if (isDown)
      return { label: "SISTEMA INDISPONÍVEL", color: STATUS_COLORS.offline };
    if (isSlow)
      return {
        label: "SISTEMA LENTO / DEGRADADO",
        color: STATUS_COLORS.degraded,
      };
    if (isChecking)
      return {
        label: "VERIFICANDO INSTABILIDADE...",
        color: STATUS_COLORS.degraded,
      };
    if (recentlyRecovered)
      return { label: "SISTEMA EM RECUPERAÇÃO", color: STATUS_COLORS.degraded };
    return { label: "SISTEMA OPERACIONAL", color: STATUS_COLORS.online };
  }, [data, error, recentlyRecovered]);

  if (theme === "sigaa") {
    return (
      <div className="institutional-panel w-full max-w-2xl mx-auto shadow-sm">
        <div className="institutional-panel-header text-sm sm:text-base">
          Serviço de Verificação de Disponibilidade (SVD)
        </div>

        <div className="p-6 sm:p-10 flex flex-col items-center text-center">
          {data?.currentIncident && (
            <div className="alert-banner w-full justify-center mb-6 text-red-800 text-sm sm:text-base border-red-300 bg-red-50">
              ⚠️ ALERTA: Incidente em andamento no sistema.
            </div>
          )}

          <div className="text-xs font-bold text-sigaa-muted uppercase tracking-wider mb-2">
            Estado Atual do Sistema
          </div>

          <div
            className={`text-2xl sm:text-4xl font-black mb-6 ${(!data || !data.lastCheck) && !error ? "animate-pulse" : ""}`}
            style={{ color: institutionalStatus.color }}
          >
            {institutionalStatus.label}
          </div>

          {response && (
            <>
              <div className="text-xs font-bold text-sigaa-muted uppercase tracking-wider mb-2">
                O SIGAA caiu?
              </div>
              <div className="mb-8 p-4 border border-sigaa-border-default bg-sigaa-background w-full rounded-sm">
                <div className="text-3xl mb-2">{response.emoji}</div>
                <div className="font-bold text-sigaa-text">{response.text}</div>
                <div className="text-sm text-sigaa-muted mt-1">
                  {response.sub}
                </div>
              </div>
            </>
          )}

          {error && !response && (
            <div className="mb-8 p-4 border border-sigaa-border-default bg-sigaa-background w-full rounded-sm">
              <div className="font-bold text-sigaa-text">
                Erro ao conectar com o monitor.
              </div>
              <div className="text-sm text-sigaa-muted mt-1">
                Tentando novamente em breve...
              </div>
            </div>
          )}

          {data?.lastCheck && !error && (
            <div className="flex flex-col sm:flex-row gap-3 w-full justify-center text-xs text-sigaa-muted mt-2">
              <div className="border border-sigaa-border-default px-3 py-1.5 bg-sigaa-background rounded-sm">
                Última verificação: {timeAgo(data.lastCheck.timestamp)}
              </div>
              {data.status !== "offline" &&
                data.lastCheck.responseTimeMs > 0 && (
                  <div className="border border-sigaa-border-default px-3 py-1.5 bg-sigaa-background rounded-sm">
                    Tempo de resposta: {formatMs(data.lastCheck.responseTimeMs)}
                  </div>
                )}
            </div>
          )}

          {daysSinceLastIncident !== null &&
            daysSinceLastIncident > 0 &&
            data?.status !== "offline" &&
            !error && (
              <div className="mt-8 text-xs text-sigaa-muted uppercase tracking-wider">
                Estamos ha{" "}
                <span className="font-semibold text-sigaa-text">
                  {daysSinceLastIncident}{" "}
                  {daysSinceLastIncident === 1 ? "dia" : "dias"}
                </span>{" "}
                sem incidentes registrados
              </div>
            )}
        </div>
      </div>
    );
  }

  // Default theme
  if (error) {
    return (
      <div className="text-center">
        <h1 className="text-5xl sm:text-7xl font-black tracking-tight mb-6">
          O SIGAA caiu?
        </h1>
        <p className="text-2xl text-neutral-400">
          Sei la, a gente tambem ta com problema
        </p>
        <p className="text-sm text-neutral-400 mt-2">
          Erro ao conectar com o monitor. Tentando novamente...
        </p>
      </div>
    );
  }

  if (!data || !data.lastCheck || !response) {
    return (
      <div className="text-center">
        <h1 className="text-5xl sm:text-7xl font-black tracking-tight mb-6">
          O SIGAA caiu?
        </h1>
        <p className="text-2xl text-neutral-400 animate-pulse">
          Verificando...
        </p>
      </div>
    );
  }

  return (
    <div className="text-center">
      <h1 className="text-5xl sm:text-7xl font-black tracking-tight mb-8">
        O SIGAA caiu?
      </h1>

      <div className="text-6xl sm:text-8xl mb-4">{response.emoji}</div>
      <p className={`text-3xl sm:text-4xl font-bold ${statusColor}`}>
        {response.text}
      </p>
      <p className="text-neutral-500 mt-3 text-lg">
        {response.sub}
        {data.status !== "offline" && data.lastCheck.responseTimeMs > 0 && (
          <> Respondendo em {formatMs(data.lastCheck.responseTimeMs)}</>
        )}
      </p>

      {daysSinceLastIncident !== null &&
        daysSinceLastIncident > 0 &&
        data.status !== "offline" && (
          <p className="mt-6 text-sm text-neutral-400">
            Estamos ha{" "}
            <span className="font-semibold text-neutral-600">
              {daysSinceLastIncident}{" "}
              {daysSinceLastIncident === 1 ? "dia" : "dias"}
            </span>{" "}
            sem o SIGAA cair
            <span className="ml-1 text-neutral-300">#iLoveSigaa</span>
          </p>
        )}

      <p className="text-xs text-neutral-400 mt-4">
        Ultimo check: {timeAgo(data.lastCheck.timestamp)}
      </p>
    </div>
  );
}
