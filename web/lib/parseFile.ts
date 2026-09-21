// =============================================================================
// Разбор файла в браузере — не на сервере. Та же защита от строки
// "sep=;" (Excel), что и в серверной версии.
// =============================================================================
import * as XLSX from "xlsx";
import Papa from "papaparse";

export type ParsedRow = Record<string, string>;

export async function parseUploadedFile(file: File): Promise<ParsedRow[]> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    return parseXlsx(file);
  }
  if (lower.endsWith(".csv")) {
    return parseCsv(file);
  }
  throw new Error(`Неподдерживаемый формат файла: ${file.name}`);
}

async function parseXlsx(file: File): Promise<ParsedRow[]> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
}

async function parseCsv(file: File): Promise<ParsedRow[]> {
  let text = await file.text();

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
    delimiter,
    skipEmptyLines: true,
    transformHeader: (h: string) => h.trim(),
  });

  if (parsed.errors?.length) {
    // "UndetectableDelimiter" — не ошибка, а предупреждение: Papaparse не
    // смог угадать разделитель (обычно потому, что в файле только одна
    // колонка вообще без разделителей — как раз типичный случай для
    // списка email по одному на строку) и просто использовал запятую по
    // умолчанию. Данные при этом разобраны корректно, прерывать нечего.
    const fatal = parsed.errors.find(
      (e) => e.type !== "FieldMismatch" && e.code !== "UndetectableDelimiter"
    );
    if (fatal) throw new Error(`Ошибка разбора CSV: ${fatal.message}`);
  }

  return parsed.data;
}

/** Строит xlsx-файл (Blob) из массива строк — скачивание сразу в браузере. */
export function buildXlsxBlob(rows: ParsedRow[]): Blob {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "result");
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  return new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}
