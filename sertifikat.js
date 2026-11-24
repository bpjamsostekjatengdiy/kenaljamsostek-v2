const CERTIFICATE_RESPONSE_ENDPOINT_URL =
  "https://script.google.com/macros/s/AKfycbx6sdk5STv5suSDGFjXeJUd8HmnRPco1VPiYJDEZtIsuIdikB7z6CRGcsjplHBHuyEHPg/exec";
const CERTIFICATE_TEMPLATE_URL = "./certificate-template.png";
const CERTIFICATE_WIDTH = 2000;
const CERTIFICATE_HEIGHT = 1414;

const elements = {
  form: document.querySelector("#certificate-form"),
  phone: document.querySelector("#certificate-phone"),
  eventInfo: document.querySelector("#certificate-event-info"),
  stage: document.querySelector("#certificate-stage"),
  name: document.querySelector("#certificate-name"),
  episode: document.querySelector("#certificate-episode"),
  date: document.querySelector("#certificate-date"),
  serial: document.querySelector("#certificate-serial"),
  print: document.querySelector("#print-certificate"),
  status: document.querySelector("#certificate-status"),
  message: document.querySelector("#message"),
};

// Aturan sertifikat (jam buka, batas Feedback, maks unduh, skor minimal, dll.)
// diatur di sheet pengaturan_sertifikat dan dicek oleh Apps Script.
let currentCertificate = null;
let currentPrintCount = 0;
let maxPrint = 2;
let certificateStatus = null;

window.addEventListener("DOMContentLoaded", () => {
  elements.date.textContent = formatLongDate(new Date());
  enableCertificatePageProtection();
  updatePrintButton(0, true);
  loadCertificateStatus();
});

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await generateCertificate();
});

elements.print.addEventListener("click", async () => {
  await printCertificate();
});

async function loadCertificateStatus() {
  try {
    const response = await fetch(`${CERTIFICATE_RESPONSE_ENDPOINT_URL}?action=certificate_status`);
    certificateStatus = await response.json();
  } catch (error) {
    certificateStatus = null;
    showMessage("Pengaturan sertifikat belum bisa dimuat. Coba lagi sebentar.");
    return;
  }

  maxPrint = Number.isFinite(Number(certificateStatus.maxPrint)) ? Number(certificateStatus.maxPrint) : 2;
  updatePrintButton(0, true);
  const today = new Date();
  const episode = certificateStatus.episode || "Episode belum tersedia";
  elements.eventInfo.textContent = `Kegiatan DIJAMIN : ${episode} tanggal ${formatLongDate(today)}`;

  if (!certificateStatus.open) {
    showCertificateStatus(certificateStatus.message || "Halaman sertifikat sedang ditutup.");
  }
}

async function generateCertificate() {
  const phone = normalizePhone(elements.phone.value);
  currentCertificate = null;
  currentPrintCount = 0;
  updatePrintButton(0, true);
  elements.status.classList.add("hidden");
  elements.status.innerHTML = "";

  if (!phone) {
    showMessage("Masukkan nomor HP terlebih dahulu.");
    return;
  }

  let result;

  try {
    const response = await fetch(CERTIFICATE_RESPONSE_ENDPOINT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "certificate_check", phone }),
    });
    result = await response.json();
  } catch (error) {
    showMessage("Data sertifikat belum bisa dicek. Coba lagi sebentar.");
    return;
  }

  if (!result.ok) {
    elements.stage.classList.add("hidden");
    showCertificateStatus(result.message);
    showMessage(result.message);
    return;
  }

  maxPrint = Number.isFinite(Number(result.maxPrint)) ? Number(result.maxPrint) : maxPrint;
  const participantDateObject = getDateObject(result.submittedAt) || new Date();
  const participantName = String(result.name || "").toUpperCase();
  const episodeText = result.episode || `"${result.theme || "Kegiatan Literasi New DIJAMIN"}"`;
  const dateText = formatLongDate(participantDateObject);
  const serialText = `SERIAL: ${formatPhoneForSerial(phone)}-${formatSerialDate(participantDateObject)}`;
  currentCertificate = {
    phone,
    dateKey: result.dateKey,
    name: participantName,
    episode: episodeText,
    date: dateText,
    serial: serialText,
    limitMessage: result.batasUnduhMessage,
  };
  currentPrintCount = Number(result.printCount) || 0;

  elements.name.textContent = participantName;
  elements.episode.textContent = episodeText;
  elements.date.textContent = dateText;
  elements.serial.textContent = serialText;
  updatePrintButton(currentPrintCount, isPrintLimitReached());
  elements.stage.classList.remove("hidden");
  elements.status.classList.add("hidden");
  elements.status.innerHTML = "";

  if (isPrintLimitReached()) {
    showCertificateStatus(currentCertificate.limitMessage || "Batas download sertifikat sudah tercapai.");
    showMessage("Batas download sertifikat sudah tercapai.");
    return;
  }

  showMessage(result.message || "Sertifikat siap diunduh.");
}

function isPrintLimitReached() {
  return maxPrint > 0 && currentPrintCount >= maxPrint;
}

async function printCertificate() {
  if (!currentCertificate) {
    showMessage("Tampilkan sertifikat terlebih dahulu.");
    return;
  }

  if (isPrintLimitReached()) {
    updatePrintButton(currentPrintCount, true);
    showCertificateStatus(currentCertificate.limitMessage || "Batas download sertifikat sudah tercapai.");
    showMessage("Batas download sertifikat sudah tercapai.");
    return;
  }

  elements.print.disabled = true;
  elements.print.textContent = "Menyiapkan JPG...";

  try {
    await downloadCertificateJpg(currentCertificate);
  } catch (error) {
    updatePrintButton(currentPrintCount, false);
    showMessage("Sertifikat belum bisa dibuat sebagai JPG. Coba lagi sebentar.");
    return;
  }

  currentPrintCount += 1;
  updatePrintButton(currentPrintCount, isPrintLimitReached());
  recordCertificatePrint(currentCertificate);
  showMessage("Sertifikat JPG berhasil diunduh.");
}

function updatePrintButton(count, disabled = false) {
  elements.print.textContent = maxPrint > 0 ? `Download JPG (${count}/${maxPrint})` : "Download JPG";
  elements.print.disabled = disabled;
}

async function downloadCertificateJpg(certificate) {
  const canvas = document.createElement("canvas");
  canvas.width = CERTIFICATE_WIDTH;
  canvas.height = CERTIFICATE_HEIGHT;
  const context = canvas.getContext("2d");
  const template = await loadImage(CERTIFICATE_TEMPLATE_URL);

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, CERTIFICATE_WIDTH, CERTIFICATE_HEIGHT);
  context.drawImage(template, 0, 0, CERTIFICATE_WIDTH, CERTIFICATE_HEIGHT);

  drawCenteredFittedText(context, certificate.name, {
    x: CERTIFICATE_WIDTH / 2,
    y: CERTIFICATE_HEIGHT * 0.328,
    maxWidth: CERTIFICATE_WIDTH * 0.58,
    maxLines: 2,
    fontSize: 54,
    minFontSize: 34,
    weight: 950,
    color: "#111827",
    lineHeight: 1.05,
  });

  drawCenteredFittedText(context, certificate.episode, {
    x: CERTIFICATE_WIDTH / 2,
    y: CERTIFICATE_HEIGHT * 0.606,
    maxWidth: CERTIFICATE_WIDTH * 0.64,
    maxLines: 2,
    fontSize: 38,
    minFontSize: 24,
    weight: 850,
    color: "#111827",
    lineHeight: 1.15,
  });

  drawCenteredFittedText(context, `Semarang, ${certificate.date}`, {
    x: CERTIFICATE_WIDTH / 2,
    y: CERTIFICATE_HEIGHT * 0.698,
    maxWidth: CERTIFICATE_WIDTH * 0.44,
    maxLines: 1,
    fontSize: 22,
    minFontSize: 16,
    weight: 500,
    color: "#4b5563",
    lineHeight: 1,
  });

  context.fillStyle = "#536171";
  context.font = "700 17px Inter, Arial, sans-serif";
  context.textAlign = "left";
  context.textBaseline = "alphabetic";
  context.fillText(certificate.serial, CERTIFICATE_WIDTH * 0.046, CERTIFICATE_HEIGHT * 0.958);

  const link = document.createElement("a");
  link.href = canvas.toDataURL("image/jpeg", 0.94);
  link.download = `sertifikat-dijamin-${slugify(certificate.name)}-${certificate.dateKey}.jpg`;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

function drawCenteredFittedText(context, text, options) {
  const content = String(text || "").trim();
  let fontSize = options.fontSize;
  let lines = [];

  do {
    context.font = `${options.weight} ${fontSize}px Inter, Arial, sans-serif`;
    lines = wrapText(context, content, options.maxWidth);

    if (lines.length <= options.maxLines) {
      break;
    }

    fontSize -= 2;
  } while (fontSize > options.minFontSize);

  if (lines.length > options.maxLines) {
    lines = lines.slice(0, options.maxLines);
    lines[lines.length - 1] = trimTextToWidth(context, `${lines[lines.length - 1]}...`, options.maxWidth);
  }

  context.fillStyle = options.color;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = `${options.weight} ${fontSize}px Inter, Arial, sans-serif`;

  const lineHeight = fontSize * options.lineHeight;
  const startY = options.y - ((lines.length - 1) * lineHeight) / 2;

  lines.forEach((line, index) => {
    context.fillText(line, options.x, startY + index * lineHeight);
  });
}

function wrapText(context, text, maxWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = "";

  words.forEach((word) => {
    const testLine = line ? `${line} ${word}` : word;

    if (context.measureText(testLine).width <= maxWidth || !line) {
      line = testLine;
      return;
    }

    lines.push(line);
    line = word;
  });

  if (line) {
    lines.push(line);
  }

  return lines;
}

function trimTextToWidth(context, text, maxWidth) {
  let output = text;

  while (output.length > 1 && context.measureText(output).width > maxWidth) {
    output = `${output.slice(0, -4).trim()}...`;
  }

  return output;
}

function slugify(value) {
  return String(value || "peserta")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}


function recordCertificatePrint(certificate) {
  const payload = {
    action: "certificate_print",
    phone: certificate.phone,
    dateKey: certificate.dateKey,
    requestedAt: new Date().toISOString(),
  };
  const body = JSON.stringify(payload);

  if (navigator.sendBeacon) {
    const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
    navigator.sendBeacon(CERTIFICATE_RESPONSE_ENDPOINT_URL, blob);
    return;
  }

  fetch(CERTIFICATE_RESPONSE_ENDPOINT_URL, {
    method: "POST",
    mode: "no-cors",
    keepalive: true,
    headers: {
      "Content-Type": "text/plain;charset=utf-8",
    },
    body,
  }).catch(() => {
    showMessage("Counter cetak belum tersinkron. Coba cek koneksi internet.");
  });
}







function showCertificateStatus(text) {
  elements.status.textContent = text;

  if (text.includes("Feedback")) {
    const link = document.createElement("a");
    link.href = "./feedback.html";
    link.textContent = "Buka halaman Feedback";
    elements.status.append(document.createElement("br"), link);
  }

  elements.status.classList.remove("hidden");
}





function normalizeDateText(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);

  if (!match) {
    return "";
  }

  const day = match[1].padStart(2, "0");
  const month = match[2].padStart(2, "0");
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${year}-${month}-${day}`;
}

function normalizeObjectKeys(row) {
  return Object.keys(row || {}).reduce((record, key) => {
    record[cleanKey(key)] = row[key];
    return record;
  }, {});
}

function normalizeSpreadsheetUrl(input, sheetName) {
  const url = new URL(input, window.location.href);
  const publishedMatch = url.pathname.match(/\/spreadsheets\/d\/e\/([^/]+)/);
  const documentMatch = url.pathname.match(/\/spreadsheets\/d\/([^/]+)/);

  if (publishedMatch) {
    return `https://docs.google.com/spreadsheets/d/e/${publishedMatch[1]}/pub?output=csv&sheet=${encodeURIComponent(sheetName)}`;
  }

  if (documentMatch) {
    return `https://docs.google.com/spreadsheets/d/${documentMatch[1]}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
  }

  return url.href;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let insideQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && insideQuotes && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      insideQuotes = !insideQuotes;
    } else if (char === "," && !insideQuotes) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !insideQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(cell);
      if (row.some((value) => value.trim() !== "")) {
        rows.push(row);
      }
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  row.push(cell);
  if (row.some((value) => value.trim() !== "")) {
    rows.push(row);
  }

  if (rows.length < 2) {
    return [];
  }

  const headers = rows[0].map((header) => cleanKey(header));
  return rows.slice(1).map((values) =>
    headers.reduce((record, header, index) => {
      record[header] = (values[index] || "").trim();
      return record;
    }, {}),
  );
}

function cleanKey(value) {
  return value.trim().toLowerCase().replace(/\s+/g, "_");
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");

  if (!digits) {
    return "";
  }

  if (digits.startsWith("62")) {
    return `0${digits.slice(2)}`;
  }

  if (digits.startsWith("8")) {
    return `0${digits}`;
  }

  return digits;
}

function formatPhoneForSerial(value) {
  const digits = String(value || "").replace(/\D/g, "");

  if (digits.startsWith("62")) {
    return digits.slice(2);
  }

  if (digits.startsWith("0")) {
    return digits.slice(1);
  }

  return digits;
}

function getSessionType(value) {
  const session = String(value || "").trim().toLowerCase().replace(/\s+/g, "");

  if (["feedback", "posttest", "postest", "post"].includes(session)) {
    return "post";
  }

  return "";
}

function getDateKey(value) {
  return ResultPolicy.getDateKey(value);
}

function getDateObject(value) {
  const date = new Date(ResultPolicy.getTimestamp(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatLongDate(date) {
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Jakarta",
  }).format(date);
}

function formatSerialDate(date) {
  const key = getDateKey(date);
  return key ? `${key.slice(8, 10)}${key.slice(5, 7)}${key.slice(2, 4)}` : "";
}

function enableCertificatePageProtection() {
  document.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    showMessage("Aksi ini dinonaktifkan pada halaman sertifikat.");
  });

  document.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    const blockedShortcut =
      event.key === "F12" ||
      (event.ctrlKey && event.shiftKey && ["i", "j", "c"].includes(key)) ||
      (event.ctrlKey && ["u", "s"].includes(key));

    if (!blockedShortcut) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    showMessage("Aksi ini dinonaktifkan pada halaman sertifikat.");
  });
}

function showMessage(text) {
  elements.message.textContent = text;
  elements.message.classList.remove("hidden");
  window.clearTimeout(showMessage.timeout);
  showMessage.timeout = window.setTimeout(() => {
    elements.message.classList.add("hidden");
  }, 4200);
}
