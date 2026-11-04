// A cell that starts with = + - @ or a tab runs as a formula when the file opens in a spreadsheet, and tape text
// comes from sellers. Such text gets a leading apostrophe; plain negative numbers are left alone.
function defuse(text: string) {
  if (/^[=+@\t\r]/.test(text) || (text.startsWith("-") && !/^-\d+(\.\d+)?$/.test(text))) return `'${text}`;
  return text;
}

export function toCsv(rows: Record<string, string | number | null | undefined>[]) {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const escape = (value: unknown) => {
    const text = value == null ? "" : typeof value === "string" ? defuse(value) : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [headers.join(","), ...rows.map((row) => headers.map((header) => escape(row[header])).join(","))].join("\n");
}
