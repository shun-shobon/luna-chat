const JST_OFFSET_MS = 9 * 60 * 60 * 1_000;

export function formatDateTimeJst(date: Date): string {
  const jstDate = new Date(date.getTime() + JST_OFFSET_MS);
  const year = String(jstDate.getUTCFullYear());
  const month = String(jstDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(jstDate.getUTCDate()).padStart(2, "0");
  const hours = String(jstDate.getUTCHours()).padStart(2, "0");
  const minutes = String(jstDate.getUTCMinutes()).padStart(2, "0");
  const seconds = String(jstDate.getUTCSeconds()).padStart(2, "0");

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} JST`;
}
