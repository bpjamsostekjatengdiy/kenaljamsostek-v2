// Soal, kunci, skor, dan durasi resmi ditangani Apps Script.
// Browser hanya menerima SATU soal aktif, tanpa kunci jawaban.
// Teks soal digambar di <canvas>, sehingga tidak ada teks soal di DOM
// yang bisa dibaca atau disalin oleh ekstensi AI.
const RESPONSE_ENDPOINT_URL =
  "https://script.google.com/macros/s/AKfycbygnhapLNCMkIa8EBnQw3HVPBmPXmU6VvNFC_zLxJgscRtRa_I-2LTmU2EvPky1q1h7fg/exec";
const MAX_FOCUS_LOST = 2;

const state = {
  question: null,
  questionIndex: 0,
  totalQuestions: 0,
  participant: null,
  attemptId: "",
  isQuestionBankLoaded: false,
  isQuizActive: false,
  isSending: false,
  isAway: false,
  focusLostCount: 0,
  extensionDetected: false,
  sessionTitle: "",
  questionTimerId: null,
  questionDeadline: 0,
};

const elements = {
  participantForm: document.querySelector("#participant-form"),
  participantPanel: document.querySelector("#participant-panel"),
  fullName: document.querySelector("#full-name"),
  whatsappNumber: document.querySelector("#whatsapp-number"),
  companyName: document.querySelector("#company-name"),
  domicile: document.querySelector("#domicile"),
  sessionCode: document.querySelector("#session-code"),
  activeModuleLabel: document.querySelector("#active-module-label"),
  sessionDate: document.querySelector("#session-date"),
  testSession: document.querySelector("#test-session"),
  testTheme: document.querySelector("#test-theme"),
  startButton: document.querySelector("#start-button"),
  bankStatus: document.querySelector("#bank-status"),
  quizPanel: document.querySelector("#quiz-panel"),
  resultPanel: document.querySelector("#result-panel"),
  quizForm: document.querySelector("#quiz-form"),
  questionCount: document.querySelector("#question-count"),
  questionModule: document.querySelector("#question-module"),
  timerDisplay: document.querySelector("#timer-display"),
  questionText: document.querySelector("#question-text"),
  answerOptions: document.querySelector("#answer-options"),
  nextButton: document.querySelector("#next-button"),
  closeButton: document.querySelector("#close-button"),
  resultTitle: document.querySelector("#result-title"),
  resultSummary: document.querySelector("#result-summary"),
  durationSummary: document.querySelector("#duration-summary"),
  submitStatus: document.querySelector("#submit-status"),
  participantSummary: document.querySelector("#participant-summary"),
  reviewList: document.querySelector("#review-list"),
  message: document.querySelector("#message"),
};

window.addEventListener("DOMContentLoaded", () => {
  renderSessionHeading();
  loadThemes();
  loadSessionTitle();
  startExtensionWatch();
});

elements.participantForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!state.isQuestionBankLoaded) {
    showMessage("Tema masih dimuat. Coba lagi sebentar.");
    return;
  }

  scanForExtensions();

  if (state.extensionDetected) {
    showExtensionBlock();
    return;
  }

  state.participant = {
    fullName: elements.fullName.value.trim(),
    whatsappNumber: normalizePhoneForSheet(elements.whatsappNumber.value),
    companyName: elements.companyName.value.trim(),
    domicile: elements.domicile.value.trim(),
    testSession: elements.testSession.value,
    testTheme: elements.testTheme.value,
    testThemeLabel: getThemeLabel(elements.testTheme.value),
  };

  setLoading(true, "Menyiapkan soal...");

  try {
    const result = await postJson({
      action: "start",
      participant: state.participant,
      testSession: state.participant.testSession,
      testTheme: state.participant.testTheme,
      sessionCode: elements.sessionCode ? elements.sessionCode.value.trim() : "",
      extensionDetected: state.extensionDetected,
    });

    if (!result.ok) {
      showMessage(result.message || "Soal belum bisa dimulai.");
      return;
    }

    state.attemptId = result.attemptId;
    state.focusLostCount = 0;
    state.isAway = false;
    state.isQuizActive = true;
    elements.participantPanel.classList.add("hidden");
    elements.resultPanel.classList.add("hidden");
    elements.quizPanel.classList.remove("hidden");
    showQuestion(result);
  } catch (error) {
    showMessage("Koneksi bermasalah. Coba lagi.");
  } finally {
    setLoading(false);
  }
});

elements.testTheme.addEventListener("change", updateActiveModuleLabel);

elements.quizForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const selected = new FormData(elements.quizForm).get("answer");

  if (!selected) {
    showMessage("Pilih satu tanggapan dulu.");
    return;
  }

  sendAnswer(selected);
});

elements.closeButton.addEventListener("click", () => {
  window.close();
  showMessage("Halaman ini bisa ditutup.");
});

// Catat setiap kali peserta meninggalkan halaman quiz:
// pindah aplikasi/tab, membuka side panel AI, atau overlay asisten.
document.addEventListener("visibilitychange", () => (document.hidden ? markAway() : markBack()));
window.addEventListener("blur", markAway);
window.addEventListener("focus", markBack);

// Penghambat salin, seleksi, dan klik kanan di area quiz.
["copy", "cut", "contextmenu", "selectstart", "dragstart"].forEach((type) => {
  elements.quizPanel.addEventListener(type, (event) => event.preventDefault());
});

window.addEventListener("resize", () => {
  if (state.question && state.isQuizActive) {
    drawQuestion(state.question, true);
  }
});

function markAway() {
  if (!state.isQuizActive || state.isAway) {
    return;
  }

  state.isAway = true;
  state.focusLostCount += 1;
}

function markBack() {
  if (!state.isAway) {
    return;
  }

  state.isAway = false;
  showMessage(
    `Peringatan: Anda keluar dari halaman quiz ${state.focusLostCount}x. ` +
      `Lebih dari ${MAX_FOCUS_LOST}x tidak masuk peringkat.`,
  );
}

// --------------------------------------------------------------------
// Deteksi ekstensi browser
// Ekstensi AI (ChatGPT sidebar, Monica, Sider, Merlin, MaxAI, quiz solver, dll.)
// umumnya menyisipkan tombol/panel ke halaman. Halaman ini hanya berisi
// <main class="shell"> dan <script>, jadi elemen lain dianggap sisipan ekstensi.
// --------------------------------------------------------------------

const EXTENSION_URL_PATTERN = /^(chrome|moz|safari-web|ms-browser|edge)-extension:\/\//i;

function startExtensionWatch() {
  scanForExtensions();
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE && isForeignElement(node)) {
          flagExtension();
          return;
        }
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.setInterval(scanForExtensions, 2000);
}

function scanForExtensions() {
  const html = document.documentElement;
  const suspects = [
    ...html.children,
    ...(document.body ? document.body.children : []),
    ...document.querySelectorAll("iframe, script[src], link[href], embed, object"),
  ];

  if (suspects.some(isForeignElement) || hasCustomElements()) {
    flagExtension();
  }
}

function isForeignElement(element) {
  const tag = element.tagName.toLowerCase();
  const url = element.getAttribute("src") || element.getAttribute("href") || "";

  if (EXTENSION_URL_PATTERN.test(url)) {
    return true;
  }

  if (tag.includes("-")) {
    return true;
  }

  if (element.parentElement === document.documentElement) {
    return !["head", "body"].includes(tag);
  }

  if (element.parentElement === document.body) {
    return !(tag === "script" || tag === "noscript" || (tag === "main" && element.classList.contains("shell")));
  }

  return tag === "iframe";
}

function hasCustomElements() {
  return [...document.querySelectorAll("*")].some((element) => element.tagName.includes("-"));
}

function flagExtension() {
  if (state.extensionDetected) {
    return;
  }

  state.extensionDetected = true;

  if (!state.isQuizActive) {
    showExtensionBlock();
    return;
  }

  showMessage("Ekstensi browser terdeteksi. Hasil Anda tidak masuk peringkat.");
}

function showExtensionBlock() {
  elements.startButton.disabled = true;
  elements.bankStatus.textContent =
    "Ekstensi browser terdeteksi. Matikan semua ekstensi (termasuk asisten AI), " +
    "atau buka link ini di browser HP biasa, lalu muat ulang halaman.";
}

// --------------------------------------------------------------------
// Alur soal: satu soal per permintaan ke server
// --------------------------------------------------------------------

async function postJson(payload) {
  const response = await fetch(RESPONSE_ENDPOINT_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload),
  });
  return response.json();
}

async function loadThemes() {
  setLoading(true, "Memuat Tema...");

  try {
    const response = await fetch(`${RESPONSE_ENDPOINT_URL}?action=themes`);
    const payload = await response.json();
    const themes = Array.isArray(payload.themes) ? payload.themes : [];

    elements.testTheme.innerHTML = "";
    themes.forEach((theme) => {
      const item = document.createElement("option");
      item.value = theme;
      item.textContent = theme;
      elements.testTheme.append(item);
    });

    elements.testTheme.disabled = themes.length === 0;
    state.isQuestionBankLoaded = themes.length > 0;
    elements.bankStatus.textContent = themes.length ? "" : "Belum ada tema aktif.";
    updateActiveModuleLabel();
  } catch (error) {
    state.isQuestionBankLoaded = false;
    elements.bankStatus.textContent = "Tema belum bisa dimuat.";
  } finally {
    setLoading(false);
  }

  if (state.extensionDetected) {
    showExtensionBlock();
  }
}

function showQuestion(result) {
  state.question = result.question;
  state.questionIndex = result.index;
  state.totalQuestions = result.total;
  state.isSending = false;

  const isLast = result.index === result.total - 1;
  elements.questionCount.textContent = `Butir ${result.index + 1} dari ${result.total}`;
  elements.questionModule.textContent = result.question.moduleName || "";
  elements.nextButton.textContent = isLast ? "Kirim Jawaban" : "Lanjut";
  elements.nextButton.disabled = false;

  drawQuestion(result.question);
  startQuestionTimer(Number(result.secondsLeft));
}

function drawQuestion(question, keepSelection = false) {
  const selected = keepSelection ? new FormData(elements.quizForm).get("answer") : null;
  const textColor = getComputedStyle(elements.quizPanel).color || "#1f2937";
  const legendWidth = elements.questionText.parentElement.clientWidth || 320;

  elements.questionText.replaceChildren(
    createTextCanvas(question.text, { width: legendWidth, fontSize: 18, fontWeight: 600, color: textColor }),
  );
  elements.answerOptions.innerHTML = "";

  question.options.forEach((option) => {
    const label = document.createElement("label");
    label.className = "option-card";

    const input = document.createElement("input");
    input.type = "radio";
    input.name = "answer";
    input.value = option.letter;
    input.checked = selected === option.letter;

    const letter = document.createElement("span");
    letter.className = "option-letter";
    letter.textContent = `${option.letter}.`;

    label.append(input, letter);
    elements.answerOptions.append(label);

    const available = Math.max(
      140,
      label.clientWidth - 28 - input.offsetWidth - letter.offsetWidth - 24,
    );
    label.append(createTextCanvas(option.text, { width: available, fontSize: 16, color: textColor }));
  });
}

// Gambar teks ke canvas dengan pembungkusan baris.
function createTextCanvas(text, { width, fontSize, fontWeight = 400, color }) {
  const ratio = window.devicePixelRatio || 1;
  const fontFamily = getComputedStyle(document.body).fontFamily || "sans-serif";
  const font = `${fontWeight} ${fontSize}px ${fontFamily}`;
  const lineHeight = Math.round(fontSize * 1.4);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  context.font = font;

  const lines = [];
  String(text).split(/\n/).forEach((paragraph) => {
    let line = "";
    paragraph.split(/\s+/).forEach((word) => {
      const candidate = line ? `${line} ${word}` : word;

      if (context.measureText(candidate).width > width && line) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    });
    lines.push(line);
  });

  canvas.width = Math.ceil(width * ratio);
  canvas.height = Math.ceil(lines.length * lineHeight * ratio + 4 * ratio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${lines.length * lineHeight + 4}px`;
  canvas.className = "text-canvas";
  canvas.setAttribute("aria-hidden", "true");

  context.scale(ratio, ratio);
  context.font = font;
  context.fillStyle = color;
  context.textBaseline = "top";
  lines.forEach((line, index) => context.fillText(line, 0, index * lineHeight + 2));
  return canvas;
}

// Batas waktu per soal. Habis waktu = jawaban terpilih (atau kosong) dikirim otomatis.
function startQuestionTimer(secondsLeft) {
  stopQuestionTimer();
  const seconds = Number.isFinite(secondsLeft) ? secondsLeft : 25;
  state.questionDeadline = Date.now() + seconds * 1000;
  updateQuestionTimer();
  state.questionTimerId = window.setInterval(updateQuestionTimer, 250);
}

function updateQuestionTimer() {
  const remaining = Math.max(0, Math.ceil((state.questionDeadline - Date.now()) / 1000));
  elements.timerDisplay.textContent = formatClock(remaining);
  elements.timerDisplay.classList.toggle("timer-warning", remaining <= 5);

  if (remaining === 0) {
    sendAnswer(new FormData(elements.quizForm).get("answer") || "");
  }
}

function stopQuestionTimer() {
  if (state.questionTimerId) {
    window.clearInterval(state.questionTimerId);
    state.questionTimerId = null;
  }
}

async function sendAnswer(answer) {
  if (!state.isQuizActive || state.isSending) {
    return;
  }

  state.isSending = true;
  stopQuestionTimer();
  elements.nextButton.disabled = true;
  elements.nextButton.textContent = "Mengirim...";
  elements.answerOptions.querySelectorAll("input").forEach((input) => {
    input.disabled = true;
  });

  const payload = {
    action: "answer",
    attemptId: state.attemptId,
    index: state.questionIndex,
    answer,
    focusLostCount: state.focusLostCount,
    extensionDetected: state.extensionDetected,
  };

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const result = await postJson(payload);

      if (!result.ok) {
        state.isQuizActive = false;
        showResultError(result.message || "Jawaban belum tersimpan.");
        return;
      }

      if (result.done) {
        showResult(result);
        return;
      }

      showQuestion(result);
      return;
    } catch (error) {
      showMessage(`Koneksi bermasalah, mencoba lagi (${attempt}/3)...`);
      await new Promise((resolve) => window.setTimeout(resolve, 1500 * attempt));
    }
  }

  state.isQuizActive = false;
  showResultError("Jawaban belum terkirim. Muat ulang halaman dan isi data yang sama untuk melanjutkan.");
}

function showResult(result) {
  state.isQuizActive = false;
  state.question = null;
  elements.quizPanel.classList.add("hidden");
  elements.resultPanel.classList.remove("hidden");
  elements.resultTitle.textContent = `${result.score} poin`;
  elements.resultSummary.textContent =
    `${result.correct} dari ${result.totalQuestions} tanggapan sesuai acuan.`;
  elements.durationSummary.textContent = `Lama pengerjaan: ${result.durationText}.`;
  elements.submitStatus.textContent =
    "Jawaban tersimpan. Kunci dan pembahasan dibagikan setelah sesi ditutup.";
  elements.reviewList.innerHTML = "";
  renderParticipantSummary();
}

function showResultError(message) {
  state.question = null;
  elements.quizPanel.classList.add("hidden");
  elements.resultPanel.classList.remove("hidden");
  elements.resultTitle.textContent = "Belum tersimpan";
  elements.resultSummary.textContent = "";
  elements.durationSummary.textContent = "";
  elements.submitStatus.textContent = message;
  elements.reviewList.innerHTML = "";
  renderParticipantSummary();
}

function renderParticipantSummary() {
  elements.participantSummary.innerHTML = `
    <p><strong>Nama:</strong> ${escapeHtml(state.participant.fullName)}</p>
    <p><strong>Nomor WA:</strong> ${escapeHtml(state.participant.whatsappNumber)}</p>
    <p><strong>Perusahaan:</strong> ${escapeHtml(state.participant.companyName || "-")}</p>
    <p><strong>Kota Domisili:</strong> ${escapeHtml(state.participant.domicile)}</p>
    <p><strong>Sesi:</strong> ${escapeHtml(state.participant.testSession)}</p>
    <p><strong>Tema:</strong> ${escapeHtml(state.participant.testThemeLabel)}</p>
  `;
}

function getThemeLabel(value) {
  return elements.testTheme.selectedOptions[0]?.textContent || value;
}

function setLoading(isLoading, text = "Memuat...") {
  elements.startButton.disabled = isLoading || state.extensionDetected;
  elements.startButton.textContent = isLoading ? text : "Yuk Mulai";
}

function updateActiveModuleLabel() {
  elements.activeModuleLabel.textContent = getThemeLabel(elements.testTheme.value) || "Modul aktif";
  renderSessionHeading();
}

async function loadSessionTitle() {
  try {
    const response = await fetch(`${RESPONSE_ENDPOINT_URL}?sheet=episode&format=json`);

    if (!response.ok) {
      throw new Error("Judul kegiatan belum bisa dimuat.");
    }

    const payload = await response.json();
    const rows = Array.isArray(payload) ? payload : payload.rows || [];
    state.sessionTitle = findSessionTitle(rows, new Date());
  } catch {
    state.sessionTitle = "";
  }

  renderSessionHeading();
}

function findSessionTitle(rows, date) {
  const todayKey = getJakartaDateKey(date);
  const normalizedRows = rows.map((row) => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [cleanKey(key), value]),
  ));
  const episode = normalizedRows.find((row) => getEpisodeDateKey(
    row.tanggal_pelaksanaan || row.tanggal || row.date || row.tgl || row.hari_tanggal || "",
  ) === todayKey);

  if (!episode) {
    return "";
  }

  return [episode.episode, episode.topik, episode.tema, episode.judul, episode.nama_episode, episode.nama_modul]
    .map((value) => String(value || "").trim()).find(Boolean) || "";
}

function getEpisodeDateKey(value) {
  const text = String(value || "").trim();
  const local = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2}|\d{4})$/);

  if (local) {
    const year = local[3].length === 2 ? `20${local[3]}` : local[3];
    const key = `${year}-${local[2].padStart(2, "0")}-${local[1].padStart(2, "0")}`;
    return getJakartaDateKey(`${key}T00:00:00+07:00`) === key ? key : "";
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return getJakartaDateKey(`${text}T00:00:00+07:00`) === text ? text : "";
  }

  return getJakartaDateKey(value);
}

function getJakartaDateKey(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function renderSessionHeading() {
  const dateLabel = document.createElement("span");
  dateLabel.textContent = `Sesi DIJAMIN tanggal ${formatLongDate(new Date())}`;
  const title = state.sessionTitle || (state.isQuestionBankLoaded ? getThemeLabel(elements.testTheme.value) : "");
  elements.sessionDate.replaceChildren(dateLabel);

  if (title) {
    const titleLabel = document.createElement("span");
    titleLabel.className = "session-title";
    titleLabel.textContent = ` | ${title}`;
    elements.sessionDate.append(titleLabel);
  }
}

function showMessage(text) {
  elements.message.textContent = text;
  elements.message.classList.remove("hidden");
  window.clearTimeout(showMessage.timeout);
  showMessage.timeout = window.setTimeout(() => {
    elements.message.classList.add("hidden");
  }, 4200);
}

function cleanKey(value) {
  return value.trim().toLowerCase().replace(/\s+/g, "_");
}

function normalizeAnswer(value) {
  return value.trim().toUpperCase().replace(/[^A-E]/g, "").slice(0, 1);
}

function normalizePhoneForSheet(value) {
  const digits = String(value || "").replace(/\D/g, "");

  if (digits.startsWith("62")) {
    return digits.slice(2);
  }

  if (digits.startsWith("0")) {
    return digits.slice(1);
  }

  return digits;
}

function getAnswerText(question, letter) {
  return question.options.find((option) => option.letter === letter)?.text || "";
}

function shuffleArray(items) {
  const shuffled = [...items];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[index]];
  }

  return shuffled;
}

function formatClock(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function formatDuration(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${seconds} detik`;
  }

  return `${minutes} menit ${seconds} detik`;
}

function formatLongDate(date) {
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Jakarta",
  }).format(date);
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
