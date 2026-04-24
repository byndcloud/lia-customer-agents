/**
 * Bloco de instruções com a data corrente para interpretação de referências
 * temporais do cliente ("ontem", "semana passada") sem confundir com fatos
 * históricos do relato (ex.: contrato desde 2021).
 */

const DEFAULT_TIME_ZONE = "America/Sao_Paulo";

/**
 * Monta o trecho fixo de contexto temporal injetado nos prompts de agentes
 * que conversam com o cliente (triagem, consulta processual).
 *
 * @param now - Instantâneo de referência; em testes use data fixa.
 * @param timeZone - IANA TZ; padrão Brasil (escritório).
 */
export function buildAgentTemporalContextSection(
  now: Date = new Date(),
  timeZone: string = DEFAULT_TIME_ZONE,
): string {
  const weekday = new Intl.DateTimeFormat("pt-BR", {
    weekday: "long",
    timeZone,
  }).format(now);

  const calendarPt = new Intl.DateTimeFormat("pt-BR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone,
  }).format(now);

  const isoDate = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).format(now);

  const capitalizedWeekday =
    weekday.length > 0
      ? weekday.charAt(0).toLocaleUpperCase("pt-BR") + weekday.slice(1)
      : weekday;

  return `## Contexto temporal (âncora do atendimento)
- **Data de referência** do escritório (Brasil, fuso \`${timeZone}\`): **${capitalizedWeekday}**, ${calendarPt} (ISO local: \`${isoDate}\`).
- Use essa âncora para interpretar o que o **cliente** disser em termos **relativos ao momento atual**: "ontem", "anteontem", "semana passada", "na quinta", "no começo do mês", "há X dias", "recentemente" (salvo quando o próprio cliente definir outro recorte).
- Datas ou períodos **históricos narrados pelo cliente** como parte do caso (admissão, contrato, "desde janeiro de 2021", demissão em data X, etc.) são **fatos do relato**, não são "hoje" — não misture com a data de referência acima nem trate como expressão relativa ao atendimento atual, exceto se o cliente usar referência relativa explícita a um marco que ele mesmo citou.`;
}
