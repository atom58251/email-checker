// =============================================================================
// Разбор загруженного файла (.xlsx или .csv) в массив строк-объектов.
// Портирует защиту от строки "sep=;" (Excel) из Python-версии.
// =============================================================================
import * as XLSX from "npm:xlsx@0.18.5";
import Papa from "npm:papaparse@5.4.1";

export type ParsedRow = Record<string, string>;

export function parseUploadedFile(bytes: Uint8Array, filename: string): ParsedRow[] {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    return parseXlsx(bytes);
  }
  if (lower.endsWith(".csv")) {
    return parseCsv(bytes);
  }
  throw new Error(`Неподдерживаемый формат файла: ${filename}`);
}

function parseXlsx(bytes: Uint8Array): ParsedRow[] {
  const wb = XLSX.read(bytes, { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
}

function parseCsv(bytes: Uint8Array): ParsedRow[] {
  let text = new TextDecoder("utf-8").decode(bytes);

  // защита от служебной строки Excel "sep=;" в начале файла —
  // без этого все колонки съезжают на одну позицию (см. диалог про
  // ошибку "В отчёте нет колонки 'category'")
  const firstLineEnd = text.indexOf("\n");
  const firstLine = (firstLineEnd === -1 ? text : text.slice(0, firstLineEnd)).trim();
  const sepMatch = /^sep\s*=\s*(.)$/i.exec(firstLine);
  let delimiter: string | undefined;
  if (sepMatch) {
    delimiter = sepMatch[1];
    text = text.slice(firstLineEnd + 1);
  }

  const parsed = Papa.parse<ParsedRow>(text, {
    header: true,
    delimiter, // если не задан — Papaparse сама определит запятую/точку с запятой
    skipEmptyLines: true,
    transformHeader: (h: string) => h.trim(),
  });

  if (parsed.errors?.length) {
    // см. пояснение в web/lib/parseFile.ts — "UndetectableDelimiter" это
    // предупреждение, не ошибка, данные всё равно разобраны корректно
    const fatal = parsed.errors.find(
      (e) => e.type !== "FieldMismatch" && e.code !== "UndetectableDelimiter"
    );
    if (fatal) throw new Error(`Ошибка разбора CSV: ${fatal.message}`);
  }

  return parsed.data;
}

/** Генерирует xlsx-файл (в виде Uint8Array) из массива строк — для результата. */
export function buildXlsx(rows: ParsedRow[]): Uint8Array {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "result");
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  return new Uint8Array(out);
}
