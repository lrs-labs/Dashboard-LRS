const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 46;
const CONTENT_BOTTOM = 172;
const SPECIAL_WIN_ANSI = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85],
  [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a],
  [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92],
  [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c],
  [0x017e, 0x9e], [0x0178, 0x9f]
]);
const encoder = new TextEncoder();

function clean(value, max = 180) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function winAnsi(value) {
  const bytes = [];
  for (const char of String(value ?? "")) {
    const cp = char.codePointAt(0);
    if (cp >= 0x20 && cp <= 0x7e) bytes.push(cp);
    else if (cp >= 0xa0 && cp <= 0xff) bytes.push(cp);
    else bytes.push(SPECIAL_WIN_ANSI.get(cp) ?? 0x3f);
  }
  return bytes;
}

function pdfLiteral(value) {
  const bytes = [0x28];
  for (const byte of winAnsi(clean(value))) {
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) bytes.push(0x5c, byte);
    else if (byte === 0x0a || byte === 0x0d) bytes.push(0x20);
    else if (byte < 0x20) bytes.push(0x5c, ...encoder.encode(byte.toString(8).padStart(3, "0")));
    else bytes.push(byte);
  }
  bytes.push(0x29);
  return Uint8Array.from(bytes);
}

function concatBytes(parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

function command(text) { return encoder.encode(text); }

function textCommand(x, y, value, { size = 9, bold = false, color = "0.12 0.13 0.16" } = {}) {
  return concatBytes([
    command(`BT /${bold ? "F2" : "F1"} ${size} Tf ${color} rg 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm `),
    pdfLiteral(value),
    command(" Tj ET\n")
  ]);
}

function lineCommand(x1, y1, x2, y2, color = "0.87 0.88 0.9") {
  return command(`q ${color} RG 0.6 w ${x1} ${y1} m ${x2} ${y2} l S Q\n`);
}

function wrap(value, maxChars = 38) {
  const words = clean(value, 220).split(" ").filter(Boolean);
  if (!words.length) return [""];
  const lines = [];
  let current = "";
  for (const word of words) {
    if (word.length > maxChars) {
      if (current) { lines.push(current); current = ""; }
      for (let i = 0; i < word.length; i += maxChars) lines.push(word.slice(i, i + maxChars));
      continue;
    }
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars) { lines.push(current); current = word; }
    else current = next;
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function assignmentRows(invoice) {
  return invoice.lines.map(line => {
    const project = clean(line.project || line.client || "Sin proyecto");
    const activity = clean(line.activity || "Sin actividad");
    const caseName = clean(line.caseName || "Sin CASE");
    const work = [activity, caseName].filter(Boolean).join(" · ");
    return {
      date: clean(line.date || "Sin fecha", 32),
      project: wrap(project, 31),
      work: wrap(work, 26),
      role: clean(line.role || "—", 16),
      status: line.paidState === "paid" ? "Marcado pagado" : line.paidState === "unpaid" ? "Pendiente" : line.paidState === "zero" ? "Sin importe" : "Revisar",
      amount: typeof line.amount === "number" && Number.isFinite(line.amount) ? line.amount : null
    };
  });
}

function paginate(rows) {
  const pages = [];
  let current = [];
  let y = 574;
  for (const row of rows) {
    const rowLines = Math.max(row.project.length, row.work.length, 1);
    const height = 18 + rowLines * 11;
    if (y - height < CONTENT_BOTTOM && current.length) {
      pages.push(current);
      current = [];
      y = 574;
    }
    current.push({ ...row, height });
    y -= height;
  }
  if (current.length || !pages.length) pages.push(current);
  return pages;
}

function validateInvoice(invoice) {
  if (!invoice || !clean(invoice.technician) || !/^\d{4}-\d{2}-Q[12]$/.test(invoice.periodKey || "") ||
      !Array.isArray(invoice.lines) || invoice.lines.length === 0) throw new TypeError("invoice_data_required");
  for (const line of invoice.lines) {
    if (!["TP", "TA1", "TA2"].includes(line.role) ||
        (line.amount !== null && (typeof line.amount !== "number" || !Number.isFinite(line.amount) || line.amount < 0))) {
      throw new TypeError("invoice_line_invalid");
    }
  }
}

function formatMoney(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Revisión requerida";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function renderPage(invoice, rows, pageNumber, pageCount) {
  const parts = [];
  parts.push(textCommand(MARGIN, 746, "LRS · NOMINA", { size: 17, bold: true }));
  parts.push(textCommand(MARGIN, 727, "INVOICE DE SERVICIOS · BORRADOR DE REVISIÓN", { size: 8, bold: true, color: "0.08 0.42 0.82" }));
  parts.push(textCommand(MARGIN, 701, `Técnico: ${clean(invoice.technician)}`, { size: 10, bold: true }));
  parts.push(textCommand(MARGIN, 685, `Período: ${clean(invoice.periodLabel)}`, { size: 9 }));
  parts.push(textCommand(MARGIN, 669, `Referencia: ${clean(invoice.reference)}`, { size: 8 }));
  parts.push(textCommand(406, 701, `Preparado: ${clean(invoice.generatedAt || "Vista previa")}`, { size: 8 }));
  parts.push(textCommand(406, 685, `Asignaciones: ${invoice.lines.length}`, { size: 8 }));
  parts.push(textCommand(406, 669, `Página: ${pageNumber} de ${pageCount}`, { size: 8 }));
  parts.push(lineCommand(MARGIN, 650, PAGE_WIDTH - MARGIN, 650));
  parts.push(textCommand(MARGIN, 632, "FECHA", { size: 7, bold: true, color: "0.38 0.4 0.44" }));
  parts.push(textCommand(117, 632, "PROYECTO / CLIENTE", { size: 7, bold: true, color: "0.38 0.4 0.44" }));
  parts.push(textCommand(344, 632, "ACTIVIDAD / CASE", { size: 7, bold: true, color: "0.38 0.4 0.44" }));
  parts.push(textCommand(452, 632, "ROL", { size: 7, bold: true, color: "0.38 0.4 0.44" }));
  parts.push(textCommand(504, 632, "IMPORTE", { size: 7, bold: true, color: "0.38 0.4 0.44" }));
  parts.push(lineCommand(MARGIN, 622, PAGE_WIDTH - MARGIN, 622));
  let y = 604;
  for (const row of rows) {
    parts.push(textCommand(MARGIN, y, row.date, { size: 7.5 }));
    row.project.forEach((text, i) => parts.push(textCommand(117, y - i * 11, text, { size: 7.5 })));
    row.work.forEach((text, i) => parts.push(textCommand(344, y - i * 11, text, { size: 7.2 })));
    parts.push(textCommand(452, y, row.role, { size: 8, bold: true }));
    parts.push(textCommand(504, y, row.amount === null ? "Revisar" : formatMoney(row.amount), { size: 7.5, bold: true }));
    parts.push(textCommand(344, y - 12, `Estado: ${row.status}`, { size: 6.8, color: "0.38 0.4 0.44" }));
    y -= row.height;
    parts.push(lineCommand(MARGIN, y + 5, PAGE_WIDTH - MARGIN, y + 5, "0.93 0.93 0.94"));
  }
  if (pageNumber === pageCount) {
    const summaryY = Math.min(y - 12, CONTENT_BOTTOM + 45);
    parts.push(lineCommand(MARGIN, summaryY + 14, PAGE_WIDTH - MARGIN, summaryY + 14));
    parts.push(textCommand(MARGIN, summaryY, "RESUMEN", { size: 9, bold: true }));
    const amountMissing = (invoice.amountReviewCount || 0) > 0;
    parts.push(textCommand(MARGIN, summaryY - 16, `Total asignado: ${amountMissing ? "Revisión requerida" : formatMoney(invoice.total)}`, { size: 8.5, bold: true }));
    parts.push(textCommand(MARGIN + 220, summaryY - 16, `Marcado pagado: ${formatMoney(invoice.paid)}`, { size: 8 }));
    parts.push(textCommand(MARGIN, summaryY - 31, `Pendiente conocido: ${formatMoney(invoice.pending)}`, { size: 8 }));
    parts.push(textCommand(MARGIN + 220, summaryY - 31, `Saldo: ${formatMoney(invoice.balance)}`, { size: 8, bold: true }));
    if ((invoice.reviewCount || 0) > 0 || amountMissing) {
      parts.push(textCommand(MARGIN, summaryY - 47, "Una o más casillas o importes necesitan revisión. El saldo no es concluyente.", { size: 7.2, color: "0.63 0.36 0.05" }));
    }
    if ((invoice.reportPendingCount || 0) > 0) {
      parts.push(textCommand(MARGIN, summaryY - 60, "Hay asignaciones REALIZADO con reporte documental pendiente.", { size: 7.2, color: "0.63 0.36 0.05" }));
    }
    parts.push(textCommand(MARGIN, 92, "Las casillas del Sheet son estados administrativos; no comprueban transferencias bancarias.", { size: 7, color: "0.36 0.38 0.42" }));
    parts.push(textCommand(MARGIN, 78, "Documento de vista previa. No confirma el cierre, no marca pagos y no se archiva automáticamente.", { size: 7, color: "0.36 0.38 0.42" }));
  }
  parts.push(lineCommand(MARGIN, 58, PAGE_WIDTH - MARGIN, 58));
  parts.push(textCommand(MARGIN, 42, "LRS · Control de nómina", { size: 7, color: "0.42 0.44 0.48" }));
  parts.push(textCommand(474, 42, `${pageNumber} / ${pageCount}`, { size: 7, color: "0.42 0.44 0.48" }));
  return concatBytes(parts);
}

function objectBytes(number, body) {
  return concatBytes([command(`${number} 0 obj\n`), body, command("\nendobj\n")]);
}

function makePdf(objects) {
  const header = Uint8Array.from([37, 80, 68, 70, 45, 49, 46, 52, 10, 37, 226, 227, 207, 211, 10]);
  const parts = [header];
  const offsets = [0];
  let offset = header.length;
  objects.forEach((body, index) => {
    offsets.push(offset);
    const wrapped = objectBytes(index + 1, body);
    parts.push(wrapped);
    offset += wrapped.length;
  });
  const xrefOffset = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  parts.push(command(xref));
  return concatBytes(parts);
}

export function generatePayrollInvoicePdf(invoice) {
  validateInvoice(invoice);
  const rows = assignmentRows(invoice);
  const pages = paginate(rows);
  const pageObjects = [];
  const fontNormal = 3, fontBold = 4;
  const pageRefs = pages.map((_, i) => 5 + i * 2);
  const objects = [
    command("<< /Type /Catalog /Pages 2 0 R >>"),
    command(`<< /Type /Pages /Count ${pages.length} /Kids [${pageRefs.map(id => `${id} 0 R`).join(" ")}] >>`),
    command("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"),
    command("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>")
  ];
  pages.forEach((pageRows, i) => {
    const pageId = 5 + i * 2, streamId = pageId + 1;
    const stream = renderPage(invoice, pageRows, i + 1, pages.length);
    pageObjects.push(command(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 ${fontNormal} 0 R /F2 ${fontBold} 0 R >> >> /Contents ${streamId} 0 R >>`));
    pageObjects.push(concatBytes([command(`<< /Length ${stream.length} >>\nstream\n`), stream, command("endstream")]));
  });
  objects.push(...pageObjects);
  const fileName = `NOMINA-${invoice.periodKey}-BORRADOR.pdf`;
  return { bytes: makePdf(objects), fileName, pageCount: pages.length, state: "preview-only" };
}
